import { z } from 'zod';
import { LocaleSchema } from '../core/learning-contract';

const Card = { documentNonce: z.uuid(), cardId: z.uuid() };
const Page = z.object({ ...Card, origin: z.literal('page') }).strict();
const Manual = z
  .object({ ...Card, origin: z.literal('manual'), tabId: z.int().nonnegative() })
  .strict();
export const SpeechSourceSchema = z.discriminatedUnion('origin', [Page, Manual]);
export type SpeechSource = z.infer<typeof SpeechSourceSchema>;
export const SpeechOwnerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...Card,
      kind: z.literal('page'),
      tabId: z.int().nonnegative(),
      documentId: z.string().min(1).max(160),
      siteOrigin: z.url().max(2048),
    })
    .strict(),
  z.object({ ...Card, kind: z.literal('manual'), tabId: z.int().nonnegative() }).strict(),
]);
export type SpeechOwner = z.infer<typeof SpeechOwnerSchema>;
export const SpeechTicketSchema = z
  .object({
    speechId: z.uuid(),
    epoch: z.uuid(),
    expiresAt: z.int().positive(),
  })
  .strict();
export type SpeechTicket = z.infer<typeof SpeechTicketSchema>;
export const SpeechInputSchema = z
  .object({
    text: z
      .string()
      .max(160)
      .trim()
      .min(1)
      .refine((value) => [...value].length <= 80 && !/[<>]/.test(value)),
    language: LocaleSchema,
    languageConfirmed: z.literal(true),
    rate: z.union([z.literal(1), z.literal(0.75)]),
  })
  .strict();
export type SpeechInput = z.infer<typeof SpeechInputSchema>;
const Envelope = { protocolVersion: z.literal(1), requestId: z.uuid() };
export const SpeechMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...Envelope,
      type: z.literal('speech.ticket'),
      payload: z.object({ source: SpeechSourceSchema, clientSpeechId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('speech.start'),
      payload: z
        .object({
          source: SpeechSourceSchema,
          ticket: SpeechTicketSchema,
          input: SpeechInputSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('speech.stop'),
      payload: z.object({ source: SpeechSourceSchema, ticket: SpeechTicketSchema }).strict(),
    })
    .strict(),
]);
export type SpeechMessage = z.infer<typeof SpeechMessageSchema>;
export const SpeechLeaseSchema = z
  .object({ owner: SpeechOwnerSchema, ticket: SpeechTicketSchema, deadline: z.int().positive() })
  .strict();
export type SpeechLease = z.infer<typeof SpeechLeaseSchema>;
export type SpeechState = 'starting' | 'speaking' | 'ended' | 'canceled' | 'unavailable' | 'failed';
export const sameSpeechOwner = (left: SpeechOwner, right: SpeechOwner) =>
  left.kind === right.kind &&
  left.tabId === right.tabId &&
  left.documentNonce === right.documentNonce &&
  left.cardId === right.cardId &&
  (left.kind === 'manual' ||
    (right.kind === 'page' &&
      left.documentId === right.documentId &&
      left.siteOrigin === right.siteOrigin));
