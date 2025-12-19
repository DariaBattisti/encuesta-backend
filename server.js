const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const sgMail = require("@sendgrid/mail");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// sendgrid
function validarSendGridConfig() {
  if (!process.env.SENDGRID_API_KEY) {
    console.log("FALTA SENDGRID_API_KEY");
    return false;
  }
  if (!process.env.SENDGRID_FROM) {
    console.log("FALTA SENDGRID_FROM");
    return false;
  }
  return true;
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function enviarCorreoVotacion(correo, link) {
  if (!validarSendGridConfig()) throw new Error("SendGrid mal configurado");

  const msg = {
    to: correo,
    from: process.env.SENDGRID_FROM,
    subject: "Enlace de votacion",
    text: `Tu enlace de votacion: ${link}`,
    html: `<h3>Encuesta</h3><p>Haz clic para votar:</p><a href="${link}">${link}</a>`
  };

  const resp = await sgMail.send(msg);
  console.log("SendGrid OK:", resp?.[0]?.statusCode);
}

// bd
const db = new sqlite3.Database("encuesta.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correo TEXT UNIQUE NOT NULL,
      nombre TEXT,
      apellido TEXT,
      edad INTEGER,
      genero TEXT,
      sector TEXT,
      yaVoto INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cargos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS aspirantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idCargo INTEGER NOT NULL,
      nombre TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS votos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idParticipante INTEGER NOT NULL,
      idCargo INTEGER NOT NULL,
      idAspirante INTEGER NOT NULL,
      fecha TEXT
    )
  `, crearDatosIniciales);
});

function crearDatosIniciales() {
  db.get("SELECT COUNT(*) AS total FROM cargos", (err, row) => {
    if (err) return;
    if (row && row.total > 0) return;

    const cargos = ["Presidente", "Vicepresidente", "Secretario(a)"];
    const opciones = ["Candidato 1", "Candidato 2", "Candidato 3", "Ninguno", "No se"];

    cargos.forEach((c) => {
      db.run("INSERT INTO cargos(nombre) VALUES(?)", [c], function () {
        opciones.forEach((o) => {
          db.run(
            "INSERT INTO aspirantes(idCargo,nombre) VALUES(?,?)",
            [this.lastID, o]
          );
        });
      });
    });
  });
}

// api
app.get("/", (req, res) => {
  res.send("API Encuesta funcionando");
});

app.post("/api/participantes", (req, res) => {
  const { correo, nombre, apellido, edad, genero, sector } = req.body;
  if (!correo) return res.json({ error: "Correo obligatorio" });

  const baseFront = process.env.FRONTEND_URL;
  const link = `${baseFront}/votar.html?correo=${encodeURIComponent(correo)}`;

  db.run(
    "INSERT INTO participantes(correo,nombre,apellido,edad,genero,sector) VALUES(?,?,?,?,?,?)",
    [correo, nombre, apellido, edad, genero, sector],
    async function (err) {
      if (err && err.message && err.message.includes("UNIQUE")) {
        await enviarCorreoVotacion(correo, link);
        return res.json({ mensaje: "Correo reenviado" });
      }
      if (err) return res.json({ error: "Error al registrar" });

      await enviarCorreoVotacion(correo, link);
      res.json({ mensaje: "Registrado y correo enviado" });
    }
  );
});

app.get("/api/participantes", (req, res) => {
  db.all("SELECT * FROM participantes", (_, rows) => res.json(rows));
});

app.get("/api/participantePorCorreo", (req, res) => {
  db.get(
    "SELECT * FROM participantes WHERE correo=?",
    [req.query.correo],
    (_, p) => {
      if (!p) return res.json({ permitido: false, motivo: "No registrado" });
      if (p.yaVoto) return res.json({ permitido: false, motivo: "Ya voto" });
      res.json({ permitido: true });
    }
  );
});

app.get("/api/cargosConAspirantes", (req, res) => {
  db.all("SELECT * FROM cargos ORDER BY id ASC", (_, cargos) => {
    db.all(
      `
      SELECT * FROM aspirantes
      ORDER BY idCargo ASC,
      CASE nombre
        WHEN 'Candidato 1' THEN 1
        WHEN 'Candidato 2' THEN 2
        WHEN 'Candidato 3' THEN 3
        WHEN 'Ninguno' THEN 4
        WHEN 'No se' THEN 5
        ELSE 99
      END
      `,
      (_, asp) => {
        res.json(
          cargos.map((c) => ({
            idCargo: c.id,
            nombre: c.nombre,
            aspirantes: asp.filter((a) => a.idCargo === c.id),
          }))
        );
      }
    );
  });
});

app.post("/api/votar", (req, res) => {
  const { correo, votos } = req.body;

  db.get(
    "SELECT * FROM participantes WHERE correo=?",
    [correo],
    (_, p) => {
      if (!p || p.yaVoto) return res.json({ error: "Voto no permitido" });

      votos.forEach((v) => {
        db.run(
          "INSERT INTO votos(idParticipante,idCargo,idAspirante,fecha) VALUES(?,?,?,?)",
          [p.id, v.idCargo, v.idAspirante, new Date().toISOString()]
        );
      });

      db.run("UPDATE participantes SET yaVoto=1 WHERE id=?", [p.id]);
      res.json({ mensaje: "Voto registrado" });
    }
  );
});

app.get("/api/resultados", (req, res) => {
  db.all(
    `
    SELECT c.nombre cargo, a.nombre aspirante, COUNT(v.id) votos
    FROM cargos c
    LEFT JOIN aspirantes a ON a.idCargo=c.id
    LEFT JOIN votos v ON v.idAspirante=a.id
    GROUP BY c.id, a.id
    ORDER BY c.id ASC,
      CASE a.nombre
        WHEN 'Candidato 1' THEN 1
        WHEN 'Candidato 2' THEN 2
        WHEN 'Candidato 3' THEN 3
        WHEN 'Ninguno' THEN 4
        WHEN 'No se' THEN 5
        ELSE 99
      END
    `,
    (_, rows) => res.json(rows)
  );
});

app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});
