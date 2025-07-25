import { FastifyInstance } from "fastify";
import { 
  notificationQueue, 
  notificationTemplates, 
  userNotificationPreferences,
  notifications 
} from "../models/schema";
import { eq, and, desc, lt, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import admin from "../config/firebase/firebase";

interface NotificationData {
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  data?: any;
}

interface EmailNotificationData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SMSNotificationData {
  to: string;
  message: string;
}

export class NotificationService {
  private fastify!: FastifyInstance;

  setFastify(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  // Queue notification with priority and fail-safe delivery
  async queueNotification(data: {
    userId: string;
    type: 'push' | 'email' | 'sms' | 'in_app';
    priority?: number;
    title: string;
    message: string;
    data?: any;
    scheduledAt?: Date;
    pushToken?: string;
    email?: string;
    phone?: string;
    source?: string;
    sourceId?: string;
  }) {
    const db = this.fastify.db;
    const notificationId = uuidv4();

    try {
      // Get user preferences
      const preferences = await this.getUserPreferences(data.userId);
      
      // Check if user has enabled this type of notification
      if (!this.isNotificationAllowed(data.type, preferences)) {
        console.log(`Notification blocked by user preferences: ${data.type} for user ${data.userId}`);
        return null;
      }

      // Check quiet hours
      if (this.isQuietHours(preferences)) {
        // Schedule for after quiet hours
        data.scheduledAt = this.getNextAllowedTime(preferences);
      }

      await db.insert(notificationQueue).values({
        id: notificationId,
        userId: data.userId,
        type: data.type,
        priority: data.priority || 5,
        title: data.title,
        message: data.message,
        data: data.data ? JSON.stringify(data.data) : null,
        pushToken: data.pushToken,
        email: data.email,
        phone: data.phone,
        scheduledAt: data.scheduledAt,
        processAfter: data.scheduledAt || new Date(),
        source: data.source,
        sourceId: data.sourceId,
      });

      // Process immediately if not scheduled
      if (!data.scheduledAt) {
        setImmediate(() => this.processNotification(notificationId));
      }

      return notificationId;

    } catch (error) {
      console.error('Failed to queue notification:', error);
      return null;
    }
  }

  // Send notification from template
  async sendNotificationFromTemplate(templateKey: string, userId: string, variables: any = {}) {
    const db = this.fastify.db;

    try {
      const template = await db.query.notificationTemplates.findFirst({
        where: eq(notificationTemplates.key, templateKey)
      });

      if (!template || !template.enabled) {
        console.log(`Template not found or disabled: ${templateKey}`);
        return;
      }

      const channels = JSON.parse(template.channels);
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId)
      });

      if (!user) {
        console.log(`User not found: ${userId}`);
        return;
      }

      // Process each channel
      const promises = channels.map(async (channel: string) => {
        const content = this.processTemplate(template, channel, variables);
        
        return this.queueNotification({
          userId,
          type: channel as any,
          priority: template.priority,
          title: content.title,
          message: content.message,
          data: variables,
          email: user.email,
          phone: user.phone,
          source: variables.source || templateKey,
          sourceId: variables.sourceId,
        });
      });

      await Promise.all(promises);

    } catch (error) {
      console.error(`Failed to send notification from template ${templateKey}:`, error);
    }
  }

  // Process notification queue (called by background job)
  async processNotificationQueue(batchSize: number = 50) {
    const db = this.fastify.db;

    try {
      // Get pending notifications ordered by priority and creation time
      const pendingNotifications = await db.query.notificationQueue.findMany({
        where: and(
          eq(notificationQueue.status, 'pending'),
          lt(notificationQueue.processAfter, new Date())
        ),
        orderBy: [
          notificationQueue.priority,
          notificationQueue.createdAt
        ],
        limit: batchSize
      });

      // Process in parallel with concurrency limit
      const concurrency = 10;
      for (let i = 0; i < pendingNotifications.length; i += concurrency) {
        const batch = pendingNotifications.slice(i, i + concurrency);
        await Promise.all(batch.map(notification => 
          this.processNotification(notification.id)
        ));
      }

      return pendingNotifications.length;

    } catch (error) {
      console.error('Failed to process notification queue:', error);
      return 0;
    }
  }

  // Process individual notification
  private async processNotification(notificationId: string) {
    const db = this.fastify.db;

    try {
      const notification = await db.query.notificationQueue.findFirst({
        where: eq(notificationQueue.id, notificationId),
        with: { user: true }
      });

      if (!notification || notification.status !== 'pending') {
        return;
      }

      // Mark as processing
      await db.update(notificationQueue)
        .set({ status: 'processing', updatedAt: new Date() })
        .where(eq(notificationQueue.id, notificationId));

      let success = false;
      let error = null;
      let response = null;

      try {
        switch (notification.type) {
          case 'push':
            response = await this.sendPushNotification(notification);
            success = true;
            break;
          case 'email':
            response = await this.sendEmailNotification({
              to: notification.email || notification.user.email,
              subject: notification.title,
              html: notification.message,
            });
            success = true;
            break;
          case 'sms':
            response = await this.sendSMSNotification({
              to: notification.phone || notification.user.phone,
              message: `${notification.title}: ${notification.message}`,
            });
            success = true;
            break;
          case 'in_app':
            await this.createInAppNotification(notification);
            success = true;
            break;
        }
      } catch (deliveryError) {
        error = deliveryError.message;
        success = false;
      }

      // Update notification status
      if (success) {
        await db.update(notificationQueue)
          .set({
            status: 'sent',
            sentAt: new Date(),
            response: response ? JSON.stringify(response) : null,
            updatedAt: new Date()
          })
          .where(eq(notificationQueue.id, notificationId));
      } else {
        const newAttempts = notification.attempts + 1;
        const shouldRetry = newAttempts < notification.maxAttempts;

        await db.update(notificationQueue)
          .set({
            status: shouldRetry ? 'pending' : 'failed',
            attempts: newAttempts,
            error,
            failedAt: shouldRetry ? null : new Date(),
            processAfter: shouldRetry ? this.getRetryTime(newAttempts) : null,
            updatedAt: new Date()
          })
          .where(eq(notificationQueue.id, notificationId));
      }

    } catch (error) {
      console.error(`Failed to process notification ${notificationId}:`, error);
    }
  }

  // Send real-time notification
  async sendRealTimeNotification(data: NotificationData) {
    try {
      const notification = {
        id: uuidv4(),
        ...data,
        timestamp: new Date(),
        read: false,
      };

      // Queue for reliable delivery
      await this.queueNotification({
        userId: data.userId,
        type: 'in_app',
        title: data.title,
        message: data.message,
        data: data.data,
        source: 'real_time'
      });

      return notification;
    } catch (error) {
      throw new Error(`Failed to send real-time notification: ${error.message}`);
    }
  }

  // Send email notification
  async sendEmailNotification(data: EmailNotificationData) {
    try {
      // AWS SES implementation
      if (process.env.AWS_SES_REGION) {
        const AWS = require('aws-sdk');
        const ses = new AWS.SES({ region: process.env.AWS_SES_REGION });

        const params = {
          Source: process.env.FROM_EMAIL || 'noreply@hotelapp.com',
          Destination: { ToAddresses: [data.to] },
          Message: {
            Subject: { Data: data.subject },
            Body: {
              Html: { Data: data.html },
              Text: { Data: data.text || data.html.replace(/<[^>]*>/g, '') }
            }
          }
        };

        const result = await ses.sendEmail(params).promise();
        return { messageId: result.MessageId, provider: 'ses' };
      }

      // Fallback: Log for development
      console.log('Email notification (dev mode):', {
        to: data.to,
        subject: data.subject,
        timestamp: new Date(),
      });

      return {
        id: uuidv4(),
        to: data.to,
        subject: data.subject,
        status: 'sent',
        timestamp: new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to send email notification: ${error.message}`);
    }
  }

  // Send SMS notification
  async sendSMSNotification(data: SMSNotificationData) {
    try {
      // AWS SNS implementation
      if (process.env.AWS_SNS_REGION) {
        const AWS = require('aws-sdk');
        const sns = new AWS.SNS({ region: process.env.AWS_SNS_REGION });

        const params = {
          PhoneNumber: data.to,
          Message: data.message,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: 'Transactional'
            }
          }
        };

        const result = await sns.publish(params).promise();
        return { messageId: result.MessageId, provider: 'sns' };
      }

      // Fallback: Log for development
      console.log('SMS notification (dev mode):', {
        to: data.to,
        message: data.message,
        timestamp: new Date(),
      });

      return {
        id: uuidv4(),
        to: data.to,
        message: data.message,
        status: 'sent',
        timestamp: new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to send SMS notification: ${error.message}`);
    }
  }

  // Send push notification
  async sendPushNotification(notification: any) {
    try {
      if (!notification.pushToken) {
        throw new Error('Push token not available');
      }

      const message = {
        token: notification.pushToken,
        notification: {
          title: notification.title,
          body: notification.message,
        },
        data: notification.data ? JSON.parse(notification.data) : {},
        android: {
          priority: 'high' as const,
        },
        apns: {
          headers: {
            'apns-priority': '10',
          },
        },
      };

      const result = await admin.messaging().send(message);
      return { messageId: result, provider: 'fcm' };

    } catch (error) {
      console.error('Push notification failed:', error);
      throw error;
    }
  }

  // Create in-app notification
  private async createInAppNotification(queueItem: any) {
    const db = this.fastify.db;

    await db.insert(notifications).values({
      id: uuidv4(),
      userId: queueItem.userId,
      title: queueItem.title,
      message: queueItem.message,
      type: 'info',
      data: queueItem.data,
    });
  }

  // Helper methods
  private async getUserPreferences(userId: string) {
    const db = this.fastify.db;
    
    let preferences = await db.query.userNotificationPreferences.findFirst({
      where: eq(userNotificationPreferences.userId, userId)
    });

    if (!preferences) {
      // Create default preferences
      const defaultPrefs = {
        id: uuidv4(),
        userId,
        pushEnabled: true,
        emailEnabled: true,
        smsEnabled: false,
        bookingNotifications: true,
        paymentNotifications: true,
        promotionalNotifications: false,
        systemNotifications: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
        timezone: 'Asia/Kolkata',
      };

      await db.insert(userNotificationPreferences).values(defaultPrefs);
      preferences = defaultPrefs;
    }

    return preferences;
  }

  private isNotificationAllowed(type: string, preferences: any): boolean {
    switch (type) {
      case 'push':
        return preferences.pushEnabled;
      case 'email':
        return preferences.emailEnabled;
      case 'sms':
        return preferences.smsEnabled;
      case 'in_app':
        return true; // Always allow in-app notifications
      default:
        return false;
    }
  }

  private isQuietHours(preferences: any): boolean {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-US', { 
      hour12: false, 
      timeZone: preferences.timezone 
    }).substring(0, 5);

    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    if (start < end) {
      return currentTime >= start && currentTime <= end;
    } else {
      return currentTime >= start || currentTime <= end;
    }
  }

  private getNextAllowedTime(preferences: any): Date {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const [hours, minutes] = preferences.quietHoursEnd.split(':');
    tomorrow.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    return tomorrow;
  }

  private getRetryTime(attempt: number): Date {
    const delays = [1, 5, 15, 30]; // minutes
    const delay = delays[Math.min(attempt - 1, delays.length - 1)];
    
    const retryTime = new Date();
    retryTime.setMinutes(retryTime.getMinutes() + delay);
    
    return retryTime;
  }

  private processTemplate(template: any, channel: string, variables: any) {
    let title = '';
    let message = '';

    switch (channel) {
      case 'push':
        title = this.replaceVariables(template.pushTitle || template.inAppTitle, variables);
        message = this.replaceVariables(template.pushBody || template.inAppMessage, variables);
        break;
      case 'email':
        title = this.replaceVariables(template.emailSubject, variables);
        message = this.replaceVariables(template.emailHtml || template.emailText, variables);
        break;
      case 'sms':
        title = '';
        message = this.replaceVariables(template.smsText, variables);
        break;
      case 'in_app':
        title = this.replaceVariables(template.inAppTitle, variables);
        message = this.replaceVariables(template.inAppMessage, variables);
        break;
    }

    return { title, message };
  }

  private replaceVariables(template: string, variables: any): string {
    if (!template) return '';
    
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] || match;
    });
  }

  // Get user notifications
  async getUserNotifications(userId: string, page: number = 1, limit: number = 10) {
    const db = this.fastify.db;

    const userNotifications = await db.query.notifications.findMany({
      where: eq(notifications.userId, userId),
      orderBy: [desc(notifications.createdAt)],
      limit,
      offset: (page - 1) * limit,
    });

    const total = await db.query.notifications.findMany({
      where: eq(notifications.userId, userId),
    });

    const unreadCount = await db.query.notifications.findMany({
      where: and(
        eq(notifications.userId, userId),
        eq(notifications.read, false)
      ),
    });

    return {
      notifications: userNotifications,
      total: total.length,
      page,
      limit,
      totalPages: Math.ceil(total.length / limit),
      unreadCount: unreadCount.length,
    };
  }

  // Mark notification as read
  async markAsRead(userId: string, notificationId: string) {
    const db = this.fastify.db;

    const result = await db.update(notifications)
      .set({ read: true, updatedAt: new Date() })
      .where(and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      ))
      .returning();

    if (result.length === 0) {
      throw new Error('Notification not found');
    }

    return result[0];
  }

  // Mark all notifications as read
  async markAllAsRead(userId: string) {
    const db = this.fastify.db;

    const result = await db.update(notifications)
      .set({ read: true, updatedAt: new Date() })
      .where(eq(notifications.userId, userId))
      .returning();

    return {
      success: true,
      markedCount: result.length,
    };
  }

  // Delete notification
  async deleteNotification(userId: string, notificationId: string) {
    const db = this.fastify.db;

    const result = await db.delete(notifications)
      .where(and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId)
      ))
      .returning();

    if (result.length === 0) {
      throw new Error('Notification not found');
    }

    return true;
  }

  // Send booking confirmation notification
  async sendBookingConfirmation(booking: any) {
    const notifications = [
      // Real-time notification
      this.sendRealTimeNotification({
        userId: booking.userId,
        title: 'Booking Confirmed',
        message: `Your booking at ${booking.hotel.name} has been confirmed for ${booking.checkInDate}`,
        type: 'success',
        data: { bookingId: booking.id },
      }),
      
      // Email notification
      this.sendEmailNotification({
        to: booking.user.email,
        subject: 'Booking Confirmation',
        html: `
          <h2>Booking Confirmed!</h2>
          <p>Dear ${booking.user.name},</p>
          <p>Your booking at <strong>${booking.hotel.name}</strong> has been confirmed.</p>
          <p><strong>Details:</strong></p>
          <ul>
            <li>Check-in: ${booking.checkInDate}</li>
            <li>Check-out: ${booking.checkOutDate}</li>
            <li>Room: ${booking.room.name}</li>
            <li>Total Amount: ₹${booking.totalAmount}</li>
          </ul>
          <p>Thank you for choosing our service!</p>
        `,
      }),
    ];

    await Promise.all(notifications);
  }

  // Send payment reminder
  async sendPaymentReminder(invoice: any) {
    const notifications = [
      // Real-time notification
      this.sendRealTimeNotification({
        userId: invoice.userId,
        title: 'Payment Reminder',
        message: `Payment of ₹${invoice.totalAmount} is due on ${invoice.dueDate}`,
        type: 'warning',
        data: { invoiceId: invoice.id },
      }),
      
      // Email notification
      this.sendEmailNotification({
        to: invoice.user.email,
        subject: 'Payment Reminder',
        html: `
          <h2>Payment Reminder</h2>
          <p>Dear ${invoice.user.name},</p>
          <p>This is a reminder that your payment of <strong>₹${invoice.totalAmount}</strong> is due on ${invoice.dueDate}.</p>
          <p>Please make the payment to avoid any inconvenience.</p>
          <p>Thank you!</p>
        `,
      }),
    ];

    await Promise.all(notifications);
  }

}