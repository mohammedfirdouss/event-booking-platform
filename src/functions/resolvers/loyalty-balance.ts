import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverEvent } from 'aws-lambda';

const logger = new Logger({ serviceName: 'loyalty-balance' });
const tracer = new Tracer({ serviceName: 'loyalty-balance' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);

interface CognitoIdentity {
  sub: string;
  username: string;
}

interface LoyaltyBalance {
  userId: string;
  points: number;
}

export const handler = async (
  event: AppSyncResolverEvent<Record<string, never>>
): Promise<LoyaltyBalance> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('getLoyaltyBalance');

  try {
    const identity = event.identity as CognitoIdentity | null;
    const userId = identity?.sub;

    if (!userId) {
      throw new Error('Unauthorized: no user identity found');
    }

    logger.info('Getting loyalty balance', { userId });

    const result = await ddb.send(new GetCommand({
      TableName: process.env.LOYALTY_TABLE!,
      Key: { userId },
    }));

    if (!result.Item) {
      // Return zero balance if record doesn't exist yet
      return { userId, points: 0 };
    }

    return result.Item as LoyaltyBalance;
  } catch (err) {
    logger.error('Error getting loyalty balance', { error: err });
    throw err;
  } finally {
    subsegment?.close();
  }
};
