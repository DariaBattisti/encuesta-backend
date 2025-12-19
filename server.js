const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const sgMail = require("@sendgrid/mail");

const app = express();
const PORT = process.env.PORT || 3000;

// habilitar JSON y acceso desde cualquier origen
app.use(cors());
app.use(express.json());

// sendgrid
function validarSendGridConfig() {
  if (!process.env.SENDGRID_API_KEY) {
    console.log("FALTA SENDGRID_API_KEY en variables de entorno");
    return false;
  }
  if (!process.env.SENDGRID_FROM) {
    console.log("FALTA SENDGRID_FROM en variables de entorno");
    return false;
  }
  return true;
}

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

async function enviarCorreoVotacion(correo, link) {
  if (!validarSendGridConfig()) throw new Error("Config de SendGrid incompleta");

  const msg = {
    to: correo,
    from: process.env.SENDGRID_FROM, 
    subject: "Enlace de votacion",
    text: `Tu enlace de votacion: ${link}`,
    html: `<h3>Encuesta</h3><p>Haz clic para votar:</p><a href="${link}">${link}</a>`,
  };

  const resp = await sgMail.send(msg);
  console.log("SendGrid: correo aceptado, status:", resp?.[0]?.statusCode);
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

  db.run(
    `
    CREATE TABLE IF NOT EXISTS votos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idParticipante INTEGER NOT NULL,
      idCargo INTEGER NOT NULL,
      idAspirante INTEGER NOT NULL,
      fecha TEXT
    )
  `,
    (err) => {
      if (err) {
        console.log("Error creando tabla votos:", err.message);
      } else {
        crearDatosIniciales();
      }
    }
  );
});

function crearDatosIniciales() {
  db.get("SELECT COUNT(*) AS total FROM cargos", (err, row) => {
    if (err) {
      console.log("Error verificando cargos:", err.message);
      return;
    }

    if (row && row.total > 0) {
      console.log("Cargos ya existen, no se insertan otra vez.");
      return;
    }

    console.log("Insertando cargos y aspirantes por defecto...");

    const cargos = ["Presidente", "Vicepresidente", "Secretario(a)"];
    const opciones = ["Candidato 1", "Candidato 2", "Candidato 3", "Ninguno", "No se"];

    db.serialize(() => {
      cargos.forEach((cargoNombre) => {
        db.run("INSERT INTO cargos(nombre) VALUES(?)", [cargoNombre], function (err2) {
          if (err2) {
            console.log("Error insertando cargo:", err2.message);
            return;
          }

          const idCargo = this.lastID;

          opciones.forEach((opcion) => {
            db.run(
              "INSERT INTO aspirantes(idCargo, nombre) VALUES(?, ?)",
              [idCargo, opcion],
              (err3) => {
                if (err3) console.log("Error insertando aspirante:", err3.message);
              }
            );
          });
        });
      });
    });
  });
}

// api

// ruta raiz
app.get("/", (req, res) => {
  res.send("API de Encuesta funcionando...");
});

// prueba rapida de correo 
app.get("/api/test-email", async (req, res) => {
  const to = req.query.to;
  if (!to) return res.json({ error: "Pasa ?to=correo@dominio.com" });

  const baseFront = process.env.FRONTEND_URL || "http://localhost:5500";
  const link = `${baseFront}/votar.html?correo=${encodeURIComponent(to)}`;

  try {
    await enviarCorreoVotacion(to, link);
    res.json({ ok: true, mensaje: "SendGrid acepto el envio (mira logs)" });
  } catch (e) {
    console.log("Error /api/test-email:", e.message);
    res.json({ ok: false, error: e.message });
  }
});

// registrar participante + enviar correo con link
app.post("/api/participantes", (req, res) => {
  const { correo, nombre, apellido, edad, genero, sector } = req.body;

  if (!correo) return res.json({ error: "Correo obligatorio" });

  const baseFront = process.env.FRONTEND_URL || "http://localhost:5500";
  const linkVotacion = `${baseFront}/votar.html?correo=${encodeURIComponent(correo)}`;

  db.run(
    "INSERT INTO participantes(correo,nombre,apellido,edad,genero,sector) VALUES(?,?,?,?,?,?)",
    [correo, nombre, apellido, edad, genero, sector],
    async function (err) {
      if (err) {
        // si ya existe, reenvia el correo
        if (err.message && err.message.includes("UNIQUE")) {
          db.get("SELECT id, correo FROM participantes WHERE correo=?", [correo], async (err2, p) => {
            if (err2 || !p) return res.json({ error: "No se pudo buscar el participante existente" });

            try {
              await enviarCorreoVotacion(correo, linkVotacion);
            } catch (e) {
              console.log("Error reenviando correo:", e.message);
              return res.json({ id: p.id, correo, warning: "Ya estaba registrado, pero no se pudo enviar el correo" });
            }

            return res.json({ id: p.id, correo, mensaje: "Ya estaba registrado, correo reenviado" });
          });
          return;
        }

        console.log("Error insertando participante:", err.message);
        return res.json({ error: "No se pudo registrar." });
      }

      // si inserto bien, enviar correo
      try {
        await enviarCorreoVotacion(correo, linkVotacion);
      } catch (e) {
        console.log("Error enviando correo:", e.message);
        return res.json({ id: this.lastID, correo, warning: "Registrado, pero no se pudo enviar el correo" });
      }

      res.json({ id: this.lastID, correo, mensaje: "Registrado y correo enviado" });
    }
  );
});

// ver participantes
app.get("/api/participantes", (req, res) => {
  db.all("SELECT * FROM participantes", (err, filas) => {
    if (err) {
      console.log("Error listando participantes:", err.message);
      return res.json([]);
    }
    res.json(filas);
  });
});

// validar voto por correo
app.get("/api/participantePorCorreo", (req, res) => {
  const correo = req.query.correo;

  db.get("SELECT * FROM participantes WHERE correo=?", [correo], (err, p) => {
    if (err) {
      console.log("Error buscando participante:", err.message);
      return res.json({ permitido: false, motivo: "Error en el servidor" });
    }

    if (!p) return res.json({ permitido: false, motivo: "Correo no registrado" });
    if (p.yaVoto == 1) return res.json({ permitido: false, motivo: "Ya voto" });

    res.json({ permitido: true, participante: p });
  });
});

// mostrar cargos con aspirantes
app.get("/api/cargosConAspirantes", (req, res) => {
  db.all("SELECT * FROM cargos", (err, cargos) => {
    if (err) {
      console.log("Error listando cargos:", err.message);
      return res.json([]);
    }

    db.all("SELECT * FROM aspirantes", (err2, aspirantes) => {
      if (err2) {
        console.log("Error listando aspirantes:", err2.message);
        return res.json([]);
      }

      const resultado = cargos.map((c) => ({
        idCargo: c.id,
        nombre: c.nombre,
        aspirantes: aspirantes.filter((a) => a.idCargo == c.id),
      }));

      res.json(resultado);
    });
  });
});

// registrar votos
app.post("/api/votar", (req, res) => {
  const { correo, votos } = req.body;

  if (!correo || !Array.isArray(votos) || votos.length === 0) {
    return res.json({ error: "Correo y votos son obligatorios" });
  }

  db.get("SELECT * FROM participantes WHERE correo=?", [correo], (err, p) => {
    if (err) {
      console.log("Error buscando participante:", err.message);
      return res.json({ error: "Error en el servidor" });
    }

    if (!p) return res.json({ error: "Correo no registrado" });
    if (p.yaVoto == 1) return res.json({ error: "Ya voto" });

    const fecha = new Date().toISOString();

    db.serialize(() => {
      votos.forEach((v) => {
        db.run(
          "INSERT INTO votos(idParticipante,idCargo,idAspirante,fecha) VALUES(?,?,?,?)",
          [p.id, v.idCargo, v.idAspirante, fecha],
          (err2) => {
            if (err2) console.log("Error insertando voto:", err2.message);
          }
        );
      });

      db.run("UPDATE participantes SET yaVoto=1 WHERE id=?", [p.id]);
    });

    res.json({ ok: true, mensaje: "Voto registrado" });
  });
});

// resultados
app.get("/api/resultados", (req, res) => {
  const sql = `
    SELECT 
      c.nombre AS cargo, 
      a.nombre AS aspirante, 
      COUNT(v.id) AS votos
    FROM cargos c
    LEFT JOIN aspirantes a ON a.idCargo = c.id
    LEFT JOIN votos v ON v.idAspirante = a.id
    GROUP BY c.id, a.id
  `;

  db.all(sql, (err, filas) => {
    if (err) {
      console.log("Error obteniendo resultados:", err.message);
      return res.json([]);
    }
    res.json(filas);
  });
});

async function cargarResultados() {
  const div = document.getElementById("resultados");
  div.textContent = "Cargando resultados...";

  try {
    const resp = await fetch(API_BASE + "/api/resultados");
    const data = await resp.json();

    if (!Array.isArray(data) || data.length === 0) {
      div.textContent = "No hay resultados disponibles.";
      return;
    }

    div.innerHTML = "";

    data.forEach((r) => {
      const fila = document.createElement("div");
      fila.textContent = `${r.cargo} - ${r.aspirante}: ${r.votos} votos`;
      div.appendChild(fila);
    });
  } catch (err) {
    console.error(err);
    div.textContent = "Error al cargar resultados.";
  }
}

// cargar resultados al abrir la pagina
window.addEventListener("DOMContentLoaded", cargarResultados);

// iniciar el servidor
app.listen(PORT, () => {
  console.log("Servidor iniciado en puerto", PORT);
});

