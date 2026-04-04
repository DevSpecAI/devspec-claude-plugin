---
name: devspec-schema
description: View the connected database schema from DevSpec
allowed-tools: mcp__devspec__get_database_schema
---

# DevSpec Schema

Show the database schema from DevSpec's connected database.

## Steps

1. Parse optional table name filter from user input.

2. Call `get_database_schema` with optional `table_name`.

3. If no database is connected:
   ```
   ✗ No database connected to this project.
     Connect a database in DevSpec: Project Settings > Database.
   ```

4. If a specific table was requested but not found:
   ```
   ✗ Table "{table_name}" not found in schema.
   ```

5. Format the schema:

   **Full schema** (no filter):
   ```
   Database Schema ({N} tables)

   {table_name}
     {column_name}: {type} {constraints}
     {column_name}: {type} {constraints}
     → {relationship description}

   {table_name}
     ...
   ```

   **Single table** (with filter):
   ```
   Table: {table_name}

   Columns:
     {column_name}: {type} {NOT NULL} {DEFAULT ...} {PRIMARY KEY}
     ...

   Relationships:
     → {referenced_table} via {foreign_key}
     ...

   Indexes:
     {index_name}: {columns}
     ...
   ```

## Rules

- Do NOT output filler text before or after the schema
- Show constraints inline (NOT NULL, DEFAULT, PRIMARY KEY)
- Show relationships with `→` arrow notation
- For full schema, keep each table compact (columns only, no indexes)
- For single table, show full detail including indexes and relationships
