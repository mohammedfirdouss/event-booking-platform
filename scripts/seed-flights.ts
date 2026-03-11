#!/usr/bin/env ts-node
/**
 * Seed 20 sample flights across 3 routes into DynamoDB.
 *
 * Usage:
 *   npx ts-node scripts/seed-flights.ts --env dev --region us-east-1
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : def;
};

const envName = getArg('--env', 'dev');
const region = getArg('--region', 'us-east-1');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const tableName = `airline-flights-${envName}`;

const routes = [
  { origin: 'JFK', destination: 'LAX' },
  { origin: 'LHR', destination: 'CDG' },
  { origin: 'SFO', destination: 'ORD' },
];

const departureDates = [
  '2025-06-01', '2025-06-02', '2025-06-03',
  '2025-06-04', '2025-06-05', '2025-06-06',
  '2025-06-07',
];

const basePrices: Record<string, number> = {
  'JFK-LAX': 299,
  'LHR-CDG': 89,
  'SFO-ORD': 179,
};

interface Flight {
  flightId: string;
  origin: string;
  destination: string;
  departureDate: string;
  availableSeats: number;
  price: number;
  airline: string;
  flightNumber: string;
  departureTime: string;
  arrivalTime: string;
}

function buildFlights(): Flight[] {
  const flights: Flight[] = [];
  let counter = 1;

  for (const route of routes) {
    const routeKey = `${route.origin}-${route.destination}`;
    const basePrice = basePrices[routeKey];

    for (let i = 0; i < Math.ceil(20 / routes.length); i++) {
      const date = departureDates[i % departureDates.length];
      const flightId = `FL-${counter.toString().padStart(3, '0')}`;

      flights.push({
        flightId,
        origin: route.origin,
        destination: route.destination,
        departureDate: date,
        availableSeats: Math.floor(Math.random() * 50) + 10,
        price: basePrice + Math.floor(Math.random() * 50),
        airline: ['SkyAir', 'CloudJet', 'AeroFast'][counter % 3],
        flightNumber: `SK${(1000 + counter).toString()}`,
        departureTime: `${8 + (counter % 12)}:00`,
        arrivalTime: `${(10 + counter) % 24}:30`,
      });
      counter++;
    }
  }

  return flights.slice(0, 20);
}

async function seed() {
  const flights = buildFlights();
  console.log(`Seeding ${flights.length} flights into ${tableName} (${region})...`);

  // BatchWrite supports max 25 items per request
  const chunks: Flight[][] = [];
  for (let i = 0; i < flights.length; i += 25) {
    chunks.push(flights.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [tableName]: chunk.map(flight => ({
          PutRequest: { Item: flight },
        })),
      },
    }));
  }

  console.log('Seeding complete!');
  console.log('Sample flights:');
  flights.slice(0, 3).forEach(f =>
    console.log(`  ${f.flightId}: ${f.origin} → ${f.destination} on ${f.departureDate} ($${f.price})`)
  );
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
