-- O navegador envia o projeto compactado (gzip em base64) e ele é guardado em pedaços,
-- porque cada linha do D1 cabe no máximo 2 MB.
CREATE TABLE project_chunks (
  user_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id, seq),
  FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
);

ALTER TABLE projects DROP COLUMN data;
