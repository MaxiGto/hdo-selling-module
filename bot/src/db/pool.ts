import pg from "pg";

// Pool compartido por todo el bot. DATABASE_URL viene del docker-compose
// definido en el servicio `bot`, no del .env compartido con Chatwoot.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on("error", (err) => {
  console.error("[db] error inesperado en el pool:", err);
});

export default pool;
