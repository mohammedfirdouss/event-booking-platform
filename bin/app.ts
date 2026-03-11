#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/stacks/data-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { EventsStack } from '../lib/stacks/events-stack';
import { BookingStack } from '../lib/stacks/booking-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') ?? 'dev';
const accountId = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID;
const alertEmail = app.node.tryGetContext('alertEmail');

if (!accountId) {
  throw new Error(
    'AWS account ID not found. Set CDK_DEFAULT_ACCOUNT or AWS_ACCOUNT_ID env var.'
  );
}

interface RegionConfig {
  region: string;
  isPrimary: boolean;
}

// Multi-region: us-east-1 primary, eu-west-1 secondary
const regions: RegionConfig[] = [
  { region: 'us-east-1', isPrimary: true },
  { region: 'eu-west-1', isPrimary: false },
];

// In dev/staging, only deploy to primary region to reduce cost
const targetRegions = envName === 'prod'
  ? regions
  : [regions[0]];

for (const { region } of targetRegions) {
  const suffix = `${envName}-${region}`;
  const env: cdk.Environment = { account: accountId, region };

  const dataStack = new DataStack(app, `DataStack-${suffix}`, {
    envName,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  const authStack = new AuthStack(app, `AuthStack-${suffix}`, {
    envName,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  const eventsStack = new EventsStack(app, `EventsStack-${suffix}`, {
    envName,
    alertEmail,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  const bookingStack = new BookingStack(app, `BookingStack-${suffix}`, {
    envName,
    dataStack,
    eventsStack,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  const apiStack = new ApiStack(app, `ApiStack-${suffix}`, {
    envName,
    dataStack,
    authStack,
    bookingStack,
    eventsStack,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  const observabilityStack = new ObservabilityStack(app, `ObservabilityStack-${suffix}`, {
    envName,
    bookingStack,
    apiStack,
    eventsStack,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });

  new ComputeStack(app, `ComputeStack-${suffix}`, {
    envName,
    bookingStack,
    observabilityStack,
    env,
    tags: { Environment: envName, Region: region, Project: 'AirlineBooking' },
  });
}

app.synth();
