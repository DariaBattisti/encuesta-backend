// librerias y configuracion
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// habilitar JSON y acceso desde cualquier origen
app.use(cors());
app.use(express.json());

// BD
const db = new sqlite3.Database("encuesta.db");

// usamos serialize para que todo se ejecute en orden
db.serialize(() => {
  // tabla de participantes
  db.run(`
    CREATE TABLE IF NOT EXISTS participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correo TEXT UNIQUE NOT NULL,
      nombre TEXT,
      apellido TEXT,
      edad INTEGER,
      genero TEXT,
      sector TEXT,
      yaVoto INTEGER DEFAULT 0  -- 0=no ha votado, 1=ya votó
    )
  `);

  //tabla de cargos (Presidente, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS cargos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL
    )
  `);

  //opciones para votar en cada cargo
  db.run(`
    CREATE TABLE IF NOT EXISTS aspirantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idCargo INTEGER NOT NULL,
      nombre TEXT NOT NULL
    )
  `);

  // tabla donde guardamos los votos
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
        // cuando ya existen TODAS las tablas insertamos los datos iniciales
        crearDatosIniciales();
      }
    }
  );
});

//datos iniciales: cargos y aspirantes
function crearDatosIniciales() {
  // revisamos si ya hay cargos
  db.get("SELECT COUNT(*) AS total FROM cargos", (err, row) => {
    if (err) {
      console.log("Error verificando cargos:", err.message);
      return;
    }

    // si ya hay no volvemos a insertar
    if (row && row.total > 0) {
      console.log("Cargos ya existen, no se insertan otra vez.");
      return;
    }

    console.log("Insertando cargos y aspirantes por defecto...");

    const cargos = ["Presidente", "Vicepresidente", "Secretario(a)"];
    const opciones = ["Candidato 1", "Candidato 2", "Candidato 3", "Ninguno", "No se"];

    db.serialize(() => {
      cargos.forEach((cargoNombre) => {
        // insertamos el cargo
        db.run("INSERT INTO cargos(nombre) VALUES(?)", [cargoNombre], function (err2) {
          if (err2) {
            console.log("Error insertando cargo:", err2.message);
            return;
          }

          const idCargo = this.lastID;

          // insertamos las 5 opciones para el cargo
          opciones.forEach((opcion) => {
            db.run(
              "INSERT INTO aspirantes(idCargo, nombre) VALUES(?, ?)",
              [idCargo, opcion],
              (err3) => {
                if (err3) {
                  console.log("Error insertando aspirante:", err3.message);
                }
              }
            );
          });
        });
      });
    });
  });
}

//registro y listado de participantes
//registrar participante
app.post("/api/participantes", (req, res) => {
  const { correo, nombre, apellido, edad, genero, sector } = req.body;

  if (!correo) return res.json({ error: "Correo obligatorio" });

  db.run(
    "INSERT INTO participantes(correo,nombre,apellido,edad,genero,sector) VALUES(?,?,?,?,?,?)",
    [correo, nombre, apellido, edad, genero, sector],
    function (err) {
      if (err) {
        console.log("Error insertando participante:", err.message);
        return res.json({ error: "No se pudo registrar (correo puede estar repetido)." });
      }
      res.json({ id: this.lastID, correo });
    }
  );
});

//ver participantes
app.get("/api/participantes", (req, res) => {
  db.all("SELECT * FROM participantes", (err, filas) => {
    if (err) {
      console.log("Error listando participantes:", err.message);
      return res.json([]);
    }
    res.json(filas);
  });
});

//validar voto por correo
app.get("/api/participantePorCorreo", (req, res) => {
  const correo = req.query.correo;

  db.get("SELECT * FROM participantes WHERE correo=?", [correo], (err, p) => {
    if (err) {
      console.log("Error buscando participante:", err.message);
      return res.json({ permitido: false, motivo: "Error en el servidor" });
    }

    if (!p) return res.json({ permitido: false, motivo: "Correo no registrado" });
    if (p.yaVoto == 1) return res.json({ permitido: false, motivo: "Ya votó" });

    res.json({ permitido: true, participante: p });
  });
});

//mostrar cargos con sus aspirantes
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

      //combinar cargos con sus aspirantes
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

  //verificar que exista el correo
  db.get("SELECT * FROM participantes WHERE correo=?", [correo], (err, p) => {
    if (err) {
      console.log("Error buscando participante:", err.message);
      return res.json({ error: "Error en el servidor" });
    }

    if (!p) return res.json({ error: "Correo no registrado" });
    if (p.yaVoto == 1) return res.json({ error: "Ya votó" });

    const fecha = new Date().toISOString();

    db.serialize(() => {
      votos.forEach((v) => {
        db.run(
          "INSERT INTO votos(idParticipante,idCargo,idAspirante,fecha) VALUES(?,?,?,?)",
          [p.id, v.idCargo, v.idAspirante, fecha],
          (err2) => {
            if (err2) {
              console.log("Error insertando voto:", err2.message);
            }
          }
        );
      });

      // marcar que ya votó
      db.run("UPDATE participantes SET yaVoto=1 WHERE id=?", [p.id]);
    });

    res.json({ ok: true, mensaje: "Voto registrado" });
  });
});

// resultados de la votación
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

// ruta raiz
app.get("/", (req, res) => {
  res.send("API de Encuesta funcionando...");
});

// iniciar el servidor
app.listen(PORT, () => {
  console.log("Servidor en http://localhost:" + PORT);
});


