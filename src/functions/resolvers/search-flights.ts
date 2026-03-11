import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverEvent } from 'aws-lambda';

const logger = new Logger({ serviceName: 'search-flights' });
const tracer = new Tracer({ serviceName: 'search-flights' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'search-flights' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);

interface SearchFlightsArgs {
  origin: string;
  destination: string;
  departureDate: string;
}

interface Flight {
  flightId: string;
  origin: string;
  destination: string;
  departureDate: string;
  availableSeats: number;
  price: number;
}

export const handler = async (
  event: AppSyncResolverEvent<SearchFlightsArgs>
): Promise<Flight[]> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('searchFlights');

  try {
    const { origin, destination, departureDate } = event.arguments;

    logger.info('Searching flights', { origin, destination, departureDate });

    const result = await ddb.send(new QueryCommand({
      TableName: process.env.FLIGHTS_TABLE!,
      IndexName: 'departureDate-origin-index',
      KeyConditionExpression: 'departureDate = :date AND origin = :origin',
      FilterExpression: 'destination = :destination AND availableSeats > :zero',
      ExpressionAttributeValues: {
        ':date': departureDate,
        ':origin': origin,
        ':destination': destination,
        ':zero': 0,
      },
    }));

    const flights = (result.Items ?? []) as Flight[];
    logger.info('Found flights', { count: flights.length });
    metrics.addMetric('FlightSearches', MetricUnit.Count, 1);

    return flights;
  } catch (err) {
    logger.error('Error searching flights', { error: err });
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
