import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'release-seat' });
const tracer = new Tracer({ serviceName: 'release-seat' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);
const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface ReleaseSeatInput {
  bookingId: string;
  flightId: string;
  seats: number;
  [key: string]: unknown;
}

export const handler = async (input: ReleaseSeatInput): Promise<ReleaseSeatInput> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('releaseSeat');

  try {
    logger.info('Releasing reserved seat (saga compensation)', {
      bookingId: input.bookingId,
      flightId: input.flightId,
      seats: input.seats,
    });

    await ddb.send(new UpdateCommand({
      TableName: process.env.FLIGHTS_TABLE!,
      Key: { flightId: input.flightId },
      UpdateExpression: 'SET availableSeats = availableSeats + :seats',
      ExpressionAttributeValues: { ':seats': input.seats },
    }));

    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'SeatReleased',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          flightId: input.flightId,
          seats: input.seats,
        }),
      }],
    }));

    logger.info('Seat released', { bookingId: input.bookingId });
    return input;
  } catch (err) {
    logger.error('Error releasing seat', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
