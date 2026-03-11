import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverEvent } from 'aws-lambda';

const logger = new Logger({ serviceName: 'get-booking' });
const tracer = new Tracer({ serviceName: 'get-booking' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);

interface GetBookingArgs {
  bookingId?: string;
}

interface CognitoIdentity {
  sub: string;
  username: string;
}

export const handler = async (
  event: AppSyncResolverEvent<GetBookingArgs>
): Promise<unknown> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('getBooking');

  try {
    // getUserBookings: no bookingId argument, query by userId
    if (!event.arguments.bookingId) {
      const identity = event.identity as CognitoIdentity | null;
      const userId = identity?.sub;

      if (!userId) {
        throw new Error('Unauthorized: no user identity found');
      }

      logger.info('Getting user bookings', { userId });

      const result = await ddb.send(new QueryCommand({
        TableName: process.env.BOOKINGS_TABLE!,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
      }));

      return result.Items ?? [];
    }

    // getBooking: single booking by ID
    const { bookingId } = event.arguments;
    logger.info('Getting booking', { bookingId });

    const result = await ddb.send(new GetCommand({
      TableName: process.env.BOOKINGS_TABLE!,
      Key: { bookingId },
    }));

    return result.Item ?? null;
  } catch (err) {
    logger.error('Error getting booking', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
