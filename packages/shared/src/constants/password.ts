/**
 * Password policy constants shared across the API route validators (Fastify
 * TypeBox schemas) and the web client forms (signup verify, team-invite
 * accept, platform-admin accept). A bump here propagates to all four sites in
 * one place so the policy can't drift between server and the three client
 * surfaces.
 *
 * Mirror these in any new credential-acceptance page; do NOT redeclare a local
 * const.
 */

/**
 * Minimum length for end-user-chosen passwords. Set to comply with the
 * realm's brute-force protection without leaking the exact policy back to
 * the frontend.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Maximum length for end-user-chosen passwords. Caps how much keyspace any
 * single bcrypt/Argon2 hash has to chew, and keeps the password field
 * comparable to Keycloak's default policy upper bound.
 */
export const PASSWORD_MAX_LENGTH = 128;
