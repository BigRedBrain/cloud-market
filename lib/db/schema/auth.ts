import { relations } from 'drizzle-orm'
import {
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { primaryKeyColumn, softDeleteColumns, timestampColumns } from './_shared'

/**
 * Authentication and authorization schema.
 *
 * Sessions are stored in the database rather than encoded into a JWT. That is a
 * deliberate trade: a stateful session costs one indexed lookup per request but
 * can be revoked the instant it needs to be — on password change, on staff
 * offboarding, or when a customer reports account takeover. For a licensed
 * cannabis retailer, "we cannot revoke that session for another 30 minutes" is
 * not an acceptable answer to a compliance question.
 */

/**
 * Roles are a fixed ladder, not a permission matrix. Three is enough for the
 * whole roadmap and a matrix nobody needs yet is a liability, not flexibility.
 *
 *  customer — shops, manages their own account and orders
 *  staff    — fulfils and dispatches orders; no pricing or user administration
 *  admin    — full access, including user administration
 */
export const userRole = pgEnum('user_role', ['customer', 'staff', 'admin'])

/**
 * Account lifecycle. `pending_verification` exists so an unverified account can
 * hold a cart but not place an order; `suspended` is reversible, and deletion is
 * soft because order history is record-retention regulated.
 */
export const userStatus = pgEnum('user_status', [
  'pending_verification',
  'active',
  'suspended',
])

/** What a one-time token authorises. */
export const tokenPurpose = pgEnum('token_purpose', [
  'email_verification',
  'password_reset',
])

export const users = pgTable(
  'users',
  {
    id: primaryKeyColumn(),

    /**
     * Stored lower-cased by the application layer, with a unique index on the
     * raw column. Postgres `citext` would be tidier but requires an extension,
     * and normalising on write keeps the invariant visible in code.
     */
    email: varchar('email', { length: 255 }).notNull(),
    emailVerifiedAt: timestamp('email_verified_at', {
      withTimezone: true,
      mode: 'date',
    }),

    /**
     * scrypt hash, encoded as `scrypt$N$r$p$salt$hash`. Nullable because an
     * OAuth-only account (a later phase) legitimately has no password.
     */
    passwordHash: text('password_hash'),

    role: userRole('role').notNull().default('customer'),
    status: userStatus('status').notNull().default('pending_verification'),

    name: varchar('name', { length: 120 }),
    phone: varchar('phone', { length: 32 }),

    /**
     * Michigan adult-use retail is 21+. Stored as a plain date — this is the
     * legal basis for serving the customer at all, so it is a required field at
     * sign-up and is re-checked at checkout rather than trusted once.
     */
    dateOfBirth: date('date_of_birth'),

    /**
     * Brute-force state. Counted per account rather than per IP because
     * credential-stuffing rotates addresses; a lockout that follows the account
     * is the one that actually protects it.
     */
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),

    ...timestampColumns,
    ...softDeleteColumns,
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    index('users_role_idx').on(table.role),
    index('users_status_idx').on(table.status),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyColumn(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * SHA-256 of the opaque session token. The plaintext token exists only in
     * the user's cookie and is never persisted, so a database disclosure leaks
     * no usable sessions — the same reasoning that applies to passwords.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** Sliding-window refresh; also drives "last active" in the session list. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    /** Shown in the account's device list so a user can recognise a session. */
    userAgent: varchar('user_agent', { length: 400 }),
    ipAddress: varchar('ip_address', { length: 45 }),

    createdAt: timestampColumns.createdAt,
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: primaryKeyColumn(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Hashed for the same reason session tokens are. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    purpose: tokenPurpose('purpose').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /**
     * Single-use enforcement. Kept as a timestamp rather than deleting the row
     * so a replayed link can be distinguished from an expired one when
     * investigating.
     */
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestampColumns.createdAt,
  },
  (table) => [
    uniqueIndex('verification_tokens_token_hash_unique').on(table.tokenHash),
    index('verification_tokens_user_id_idx').on(table.userId),
  ],
)

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  verificationTokens: many(verificationTokens),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

export const verificationTokensRelations = relations(
  verificationTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [verificationTokens.userId],
      references: [users.id],
    }),
  }),
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type UserRole = (typeof userRole.enumValues)[number]
export type UserStatus = (typeof userStatus.enumValues)[number]
