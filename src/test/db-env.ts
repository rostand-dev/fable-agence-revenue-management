// Les tests d'intégration parlent toujours à la base de test, jamais à DATABASE_URL.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
