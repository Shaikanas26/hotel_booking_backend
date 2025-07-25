import { FastifyInstance } from 'fastify';
import { BookingController } from '../controllers/booking.controller';
import {
  createBookingSchema,
  getBookingByIdSchema,
  getUserBookingsSchema,
  getHotelBookingsSchema,
  cancelBookingSchema,
  getBookingDetailsSchema
} from '../schemas/booking.schema';
import { rbacGuard } from '../plugins/rbacGuard';
import { permissions } from '../utils/rbac';

const bookingController = new BookingController();

export default async function bookingRoutes(fastify: FastifyInstance) {
  // Set fastify instance in the booking and hotel services
  bookingController['bookingService'].setFastify(fastify);
  bookingController['hotelService'].setFastify(fastify);

  // All booking routes require authentication
  fastify.addHook('onRequest', fastify.authenticate);

  // Create a new booking
  fastify.post('/', {
    schema: {
      ...createBookingSchema,
      tags: ['bookings'],
      summary: 'Create a new booking',
      security: [{ bearerAuth: [] }]
    },
    // preHandler: rbacGuard(permissions.createBooking)
  }, (request, reply) => bookingController.createBooking(request, reply));
  
  // Get booking by ID
  fastify.get('/:id', {
    schema: {
      ...getBookingByIdSchema,
      tags: ['bookings'],
      summary: 'Get booking by ID',
      security: [{ bearerAuth: [] }]
    }
  }, (request, reply) => bookingController.getBookingById(request, reply));

  // Get detailed booking information
  fastify.get('/:id/details', {
    schema: {
      ...getBookingDetailsSchema,
      tags: ['bookings'],
      summary: 'Get detailed booking information',
      security: [{ bearerAuth: [] }]
    }
  }, (request, reply) => bookingController.getBookingDetails(request, reply));
  
  // Get user's bookings
  fastify.get('/user/me', {
    schema: {
      ...getUserBookingsSchema,
      tags: ['bookings'],
      summary: 'Get user\'s bookings',
      security: [{ bearerAuth: [] }]
    },
    preHandler:[fastify.authenticate]
  }, (request, reply) => bookingController.getUserBookings(request, reply));
  
  // Get hotel bookings
  fastify.get('/hotel/:id', {
    schema: {
      ...getHotelBookingsSchema,
      tags: ['bookings'],
      summary: 'Get hotel bookings',
      security: [{ bearerAuth: [] }]
    }
  }, (request, reply) => bookingController.getHotelBookings(request, reply));
  
  // Get checkout price details
  fastify.get('/checkout/price-details', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          roomId: { type: 'string' },
          checkIn: { type: 'string', format: 'date' },
          checkOut: { type: 'string', format: 'date' },
          guests: { type: 'number', minimum: 1 }
        },
        required: ['roomId', 'checkIn', 'checkOut', 'guests']
      },
      tags: ['bookings'],
      summary: 'Get checkout price details',
      security: [{ bearerAuth: [] }]
    }
  }, (request, reply) => bookingController.getCheckoutPriceDetails(request, reply));

  // Cancel a booking
  fastify.put('/:id/cancel', {
    schema: {
      ...cancelBookingSchema,
      tags: ['bookings'],
      summary: 'Cancel a booking',
      security: [{ bearerAuth: [] }]
    }
  }, (request, reply) => bookingController.cancelBooking(request, reply));
}