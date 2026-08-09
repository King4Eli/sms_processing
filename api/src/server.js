const express = require("express");
const { ensureSchema } = require("./db");
const userApi = require("./userApi");
const workerApi = require("./workerApi");

const app = express();
app.use(express.json());

app.use("/api/v1", userApi);
app.use("/api/v1", workerApi);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error | fix you side" });
});

const port = Number(process.env.PORT || 3000);

ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`sms-processing-api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to apply schema:", err);
    process.exit(1);
  });
