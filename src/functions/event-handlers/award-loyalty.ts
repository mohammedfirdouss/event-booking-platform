import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';

const logger = new Logger({ serviceName: 'award-loyalty' });
const tracer = new Tracer({ serviceName: 'award-loyalty' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'award-loyalty' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);

// Award 1 point per dollar spent
const POINTS_PER_DOLLAR = 1;

interface BookingConfirmedDetail {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  totalPrice: number;
  confirmedAt: string;
}

export const handler = async (
  event: EventBridgeEvent<'BookingConfirmed', BookingConfirmedDetail>
): Promise<void> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('awardLoyalty');

  try {
    const { bookingId, userId, totalPrice } = event.detail;

    const pointsToAward = Math.floor(totalPrice * POINTS_PER_DOLLAR);
    logger.info('Awarding loyalty points', { bookingId, userId, totalPrice, pointsToAward });

    // Atomic ADD — safe even under concurrent writes
    await ddb.send(new UpdateCommand({
      TableName: process.env.LOYALTY_TABLE!,
      Key: { userId },
      UpdateExpression: 'ADD points :points',
      ExpressionAttributeValues: { ':points': pointsToAward },
    }));

    metrics.addMetric('LoyaltyPointsAwarded', MetricUnit.Count, pointsToAward);
    logger.info('Loyalty points awarded', { userId, pointsToAward });
  } catch (err) {
    logger.error('Error awarding loyalty points', { error: err });
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
