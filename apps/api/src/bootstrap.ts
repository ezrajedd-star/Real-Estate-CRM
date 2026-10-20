import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Logger, hashIp, redactUrl } from '@crm/platform';
import { AppModule } from './app.module.js';
import { LOGGER } from './common/tokens.js';
import { ENV, type Env } from './config/env.js';

export const API_PREFIX = 'api/v1';
const BODY_LIMIT_BYTES = 1024 * 1024; // files never pass through the API (presigned URLs)

export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: process.env.TRUST_PROXY === 'true', // behind the ALB in production
    genReqId: () => randomUUID(),
    logger: false,
  });
}

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), {
    logger: false,
    abortOnError: false, // let startup errors reach main.ts, which logs them
  });
  await configureApp(app);
  return app;
}

/** Applies every cross-cutting HTTP security control. Also used by the integration tests. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const env = app.get<Env>(ENV);
  const log = app.get<Logger>(LOGGER);

  await app.register(cookie);
  await app.register(helmet, {
    // The API serves JSON only; lock everything down.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cors, {
    origin: [env.PUBLIC_WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (req, reply) => {
    req.ctx = {
      requestId: String(req.id),
      ipHash: hashIp(req.ip, env.IP_HASH_KEY),
      userAgent:
        typeof req.headers['user-agent'] === 'string'
          ? req.headers['user-agent'].slice(0, 300)
          : null,
      user: null,
      session: null,
    };
    void reply.header('x-request-id', req.id).header('cache-control', 'no-store');
  });
  fastify.addHook('onResponse', async (req, reply) => {
    // URLs are logged without query strings and with PII-shaped segments scrubbed.
    log.info(
      {
        requestId: req.ctx?.requestId,
        method: req.method,
        url: redactUrl(req.url),
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        userId: req.ctx?.user?.id,
      },
      'request',
    );
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  await app.init();
}
