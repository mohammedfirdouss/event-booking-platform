import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'confirm-booking' });
const tracer = new Tracer({ serviceName: 'confirm-booking' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'confirm-booking' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);
const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface ConfirmBookingInput {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  paymentToken: string;
  totalPrice: number;
  reservationTimestamp: string;
  paymentId: string;
  paymentTimestamp: string;
}

export const handler = async (input: ConfirmBookingInput): Promise<ConfirmBookingInput & { confirmedAt: string }> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('confirmBooking');

  try {
    logger.info('Confirming booking', { bookingId: input.bookingId });

    const confirmedAt = new Date().toISOString();

    // Update booking record to CONFIRMED
    await ddb.send(new UpdateCommand({
      TableName: process.env.BOOKINGS_TABLE!,
      Key: { bookingId: input.bookingId },
      UpdateExpression: 'SET #status = :status, totalPrice = :price, confirmedAt = :confirmedAt, paymentId = :paymentId',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'CONFIRMED',
        ':price': input.totalPrice,
        ':confirmedAt': confirmedAt,
        ':paymentId': input.paymentId,
        ':pending': 'PENDING',
      },
    }));

    // Emit BookingConfirmed — triggers loyalty award handler
    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'BookingConfirmed',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          userId: input.userId,
          flightId: input.flightId,
          seats: input.seats,
          totalPrice: input.totalPrice,
          confirmedAt,
        }),
      }],
    }));

    metrics.addMetric('BookingSuccessRate', MetricUnit.Count, 1);
    logger.info('Booking confirmed', { bookingId: input.bookingId });

    return { ...input, confirmedAt };
  } catch (err) {
    logger.error('Error confirming booking', { error: err });
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
