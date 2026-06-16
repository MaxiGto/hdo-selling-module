-- Crea la base de datos del bot, separada de la de Chatwoot, en la misma
-- instancia de Postgres. Solo se ejecuta en la primera inicialización del
-- volumen postgres_data (si el volumen ya tiene datos, no corre de nuevo).
CREATE DATABASE oasisbot;
