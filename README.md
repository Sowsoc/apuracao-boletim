# Boletim da Apuração · 2º turno 2026

Painel ao vivo da apuração presidencial (Flávio × Lula, 25/10/2026) lido direto dos arquivos públicos do TSE pelo navegador. HTML/CSS/JS puro, sem build.

- `index.html`: estrutura · `styles.css`: visual editorial (claro/escuro) · `app.js`: leitura do TSE, projeção, render · `hexmap.js`: grade de hexágonos das UFs.
- Rodar local: `python3 -m http.server` e abrir `http://localhost:8000`.
- Fonte: `resultados.tse.jus.br/oficial/ele2026/6258` (2º turno) e `6257` (1º turno, referência).
