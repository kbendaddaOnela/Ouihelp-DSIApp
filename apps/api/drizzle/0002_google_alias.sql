-- Migration appliquée via le hotfix ensureSchemaPatches() — pas de DDL ici pour
-- éviter les erreurs si Drizzle réessaie sur une DB où les colonnes existent déjà.
SELECT 1;
