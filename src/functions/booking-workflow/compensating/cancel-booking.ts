import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'cancel-booking' });
const tracer = new Tracer({ serviceName: 'cancel-booking' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);
const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface CancelBookingInput {
  bookingId: string;
  [key: string]: unknown;
}

export const handler = async (input: CancelBookingInput): Promise<CancelBookingInput> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('cancelBooking');

  try {
    logger.info('Cancelling booking (saga compensation)', { bookingId: input.bookingId });

    const cancelledAt = new Date().toISOString();

    await ddb.send(new UpdateCommand({
      TableName: process.env.BOOKINGS_TABLE!,
      Key: { bookingId: input.bookingId },
      UpdateExpression: 'SET #status = :status, cancelledAt = :cancelledAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'CANCELLED',
        ':cancelledAt': cancelledAt,
      },
    }));

    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'BookingCancelled',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          cancelledAt,
        }),
      }],
    }));

    logger.info('Booking cancelled', { bookingId: input.bookingId });
    return input;
  } catch (err) {
    logger.error('Error cancelling booking', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
