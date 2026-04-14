-- Enable pg_trgm extension for trigram-based fuzzy matching on constituent names
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index on first_name and last_name for fast trigram similarity queries
CREATE INDEX IF NOT EXISTS constituents_first_name_trgm_idx ON constituents USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS constituents_last_name_trgm_idx ON constituents USING gin (last_name gin_trgm_ops);
