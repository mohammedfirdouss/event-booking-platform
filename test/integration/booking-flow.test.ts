/**
 * Integration test: full booking saga happy path and compensation path.
 *
 * Requires real AWS credentials and deployed stacks.
 * Run with:  AWS_REGION=us-east-1 npx jest test/integration/booking-flow.test.ts
 *
 * Set SKIP_INTEGRATION=true to skip in CI environments that don't have AWS access.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';

const SKIP = process.env.SKIP_INTEGRATION === 'true' || !process.env.STATE_MACHINE_ARN;

const region = process.env.AWS_REGION ?? 'us-east-1';
const stateMachineArn = process.env.STATE_MACHINE_ARN ?? '';
const flightsTable = process.env.FLIGHTS_TABLE ?? '';
const bookingsTable = process.env.BOOKINGS_TABLE ?? '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const sfn = new SFNClient({ region });

async function waitForExecution(executionArn: string, timeoutMs = 30000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED') {
      return status;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Execution timed out');
}

const seedFlight = async (flightId: string) =>
  ddb.send(new PutCommand({
    TableName: flightsTable,
    Item: {
      flightId,
      origin: 'JFK',
      destination: 'LAX',
      departureDate: '2025-12-01',
      availableSeats: 10,
      price: 299,
    },
  }));

const cleanupFlight = async (flightId: string) =>
  ddb.send(new DeleteCommand({ TableName: flightsTable, Key: { flightId } }));

const cleanupBooking = async (bookingId: string) =>
  ddb.send(new DeleteCommand({ TableName: bookingsTable, Key: { bookingId } }));

(SKIP ? describe.skip : describe)('Booking saga integration', () => {
  it('happy path: booking is CONFIRMED and seat count decremented', async () => {
    const flightId = `FL-INT-${randomUUID()}`;
    const bookingId = randomUUID();

    await seedFlight(flightId);

    try {
      const execution = await sfn.send(new StartExecutionCommand({
        stateMachineArn,
        name: `integration-${bookingId}`,
        input: JSON.stringify({
          bookingId,
          userId: 'int-test-user',
          flightId,
          seats: 2,
          paymentToken: 'tok_valid',
        }),
      }));

      const status = await waitForExecution(execution.executionArn!);
      expect(status).toBe('SUCCEEDED');

      const bookingResult = await ddb.send(new GetCommand({
        TableName: bookingsTable,
        Key: { bookingId },
      }));
      expect(bookingResult.Item?.status).toBe('CONFIRMED');

      const flightResult = await ddb.send(new GetCommand({
        TableName: flightsTable,
        Key: { flightId },
      }));
      expect(flightResult.Item?.availableSeats).toBe(8);
    } finally {
      await cleanupFlight(flightId);
      await cleanupBooking(bookingId);
    }
  }, 60_000);

  it('saga compensation: payment failure releases reserved seat', async () => {
    const flightId = `FL-INT-FAIL-${randomUUID()}`;
    const bookingId = randomUUID();

    await seedFlight(flightId);

    try {
      const execution = await sfn.send(new StartExecutionCommand({
        stateMachineArn,
        name: `integration-fail-${bookingId}`,
        input: JSON.stringify({
          bookingId,
          userId: 'int-test-user',
          flightId,
          seats: 2,
          paymentToken: 'tok_fail',
        }),
      }));

      const status = await waitForExecution(execution.executionArn!);
      expect(status).toBe('FAILED');

      // Seat should be restored
      const flightResult = await ddb.send(new GetCommand({
        TableName: flightsTable,
        Key: { flightId },
      }));
      expect(flightResult.Item?.availableSeats).toBe(10);
    } finally {
      await cleanupFlight(flightId);
      await cleanupBooking(bookingId);
    }
  }, 60_000);
});
