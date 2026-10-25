# STATUS — apuracao-boletim
- 2026-10-25 19h: v1 funcionando localmente com dados ao vivo do TSE (placar, "para virar", simulador, mapa hex, feed, gráfico, tabela). Regime EXECUCAO_LIVRE.
- 2026-10-25 19h16: publicado em https://sowsoc.github.io/apuracao-boletim/ (repo público, autorizado por João).
- 2026-10-25 19h30: polling 10 s; projeção com prior histórico por UF (60% 1º turno 2026 + 40% 2º turno 2022, swing regional encolhido p/ nacional); mapa e tabela × 2022.
- 2026-10-25 19h45: gravador `tools/recorder.py` publica retratos (BR+28 UFs) em `history.json` no branch `data`; site monta gráfico e feed a partir dele (mesmo para quem abre tarde). Roda em segundo plano na sessão do Claude, não como serviço.
