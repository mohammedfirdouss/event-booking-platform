import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { randomUUID } from 'crypto';

const logger = new Logger({ serviceName: 'create-booking' });
const tracer = new Tracer({ serviceName: 'create-booking' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'create-booking' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);
const sfn = tracer.captureAWSv3Client(new SFNClient({}));

interface CreateBookingArgs {
  flightId: string;
  seats: number;
  paymentToken: string;
}

interface CognitoIdentity {
  sub: string;
  username: string;
}

interface Booking {
  bookingId: string;
  userId: string;
  flightId: string;
  status: string;
  seats: number;
  totalPrice: number;
  createdAt: string;
  executionArn?: string;
}

export const handler = async (
  event: AppSyncResolverEvent<CreateBookingArgs>
): Promise<Booking> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('createBooking');

  try {
    const identity = event.identity as CognitoIdentity | null;
    const userId = identity?.sub;

    if (!userId) {
      throw new Error('Unauthorized: no user identity found');
    }

    const { flightId, seats, paymentToken } = event.arguments;
    const bookingId = randomUUID();
    const createdAt = new Date().toISOString();

    logger.info('Creating booking', { bookingId, userId, flightId, seats });
    metrics.addMetric('BookingAttempts', MetricUnit.Count, 1);

    // Write PENDING booking record
    const booking: Booking = {
      bookingId,
      userId,
      flightId,
      status: 'PENDING',
      seats,
      totalPrice: 0, // Will be calculated by workflow
      createdAt,
    };

    await ddb.send(new PutCommand({
      TableName: process.env.BOOKINGS_TABLE!,
      Item: booking,
      ConditionExpression: 'attribute_not_exists(bookingId)',
    }));

    // Start Step Functions execution
    const execution = await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN!,
      name: `booking-${bookingId}`,
      input: JSON.stringify({
        bookingId,
        userId,
        flightId,
        seats,
        paymentToken,
      }),
    }));

    // Update booking with executionArn
    booking.executionArn = execution.executionArn;

    return booking;
  } catch (err) {
    logger.error('Error creating booking', { error: err });
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
