import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const logger = new Logger({ serviceName: 'reserve-seat' });
const tracer = new Tracer({ serviceName: 'reserve-seat' });
const metrics = new Metrics({ namespace: 'AirlineBooking', serviceName: 'reserve-seat' });

const ddb = tracer.captureAWSv3Client(
  DynamoDBDocumentClient.from(new DynamoDBClient({}))
);
const eb = tracer.captureAWSv3Client(new EventBridgeClient({}));

interface ReserveSeatInput {
  bookingId: string;
  userId: string;
  flightId: string;
  seats: number;
  paymentToken: string;
}

export const handler = async (input: ReserveSeatInput): Promise<ReserveSeatInput & { reservationTimestamp: string }> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('reserveSeat');

  try {
    logger.info('Reserving seat', { bookingId: input.bookingId, flightId: input.flightId, seats: input.seats });

    // Get current flight to calculate price
    const flightResult = await ddb.send(new GetCommand({
      TableName: process.env.FLIGHTS_TABLE!,
      Key: { flightId: input.flightId },
    }));

    if (!flightResult.Item) {
      throw new Error(`Flight ${input.flightId} not found`);
    }

    const { availableSeats, price } = flightResult.Item;

    if (availableSeats < input.seats) {
      throw new Error(`Insufficient seats. Requested: ${input.seats}, Available: ${availableSeats}`);
    }

    // Atomic decrement of available seats with condition check
    await ddb.send(new UpdateCommand({
      TableName: process.env.FLIGHTS_TABLE!,
      Key: { flightId: input.flightId },
      UpdateExpression: 'SET availableSeats = availableSeats - :seats',
      ConditionExpression: 'availableSeats >= :seats',
      ExpressionAttributeValues: { ':seats': input.seats },
    }));

    const totalPrice = price * input.seats;
    const reservationTimestamp = new Date().toISOString();

    // Emit event
    await eb.send(new PutEventsCommand({
      Entries: [{
        EventBusName: process.env.EVENT_BUS_NAME!,
        Source: 'booking.workflow',
        DetailType: 'SeatReserved',
        Detail: JSON.stringify({
          bookingId: input.bookingId,
          flightId: input.flightId,
          seats: input.seats,
          reservationTimestamp,
        }),
      }],
    }));

    metrics.addMetric('SeatsReserved', MetricUnit.Count, input.seats);
    logger.info('Seat reserved successfully', { bookingId: input.bookingId, totalPrice });

    return { ...input, totalPrice, reservationTimestamp } as ReserveSeatInput & { reservationTimestamp: string };
  } catch (err) {
    logger.error('Error reserving seat', { error: err });
    throw err;
  } finally {
    subsegment?.close();
    metrics.publishStoredMetrics();
  }
};
