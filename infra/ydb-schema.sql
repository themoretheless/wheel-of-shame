-- YDB Serverless schema for Wheel of Shame
-- Run via YDB CLI: ydb -e grpc://<endpoint> -d <database> scripting yql -f ydb-schema.sql

CREATE TABLE sessions (
    id          Utf8 NOT NULL,
    title       Utf8 NOT NULL,
    created_at  Timestamp NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE participants (
    session_id  Utf8 NOT NULL,
    id          Utf8 NOT NULL,
    name        Utf8 NOT NULL,
    removed     Bool NOT NULL,
    removed_at  Timestamp,
    spin_order  Uint32,
    PRIMARY KEY (session_id, id)
);
