# Uppdrag: fixa research_grants- och GdeltMCP-servrarna (Cloudflare Workers)

Gör en branch, lägg först in den här filen i repot som `docs/felsokning-2026-11-11.md`, testa lokalt, öppna en PR och beskriv vilka secrets jag ska lägga in i Cloudflare. Ge mig klickvägar i Cloudflare-panelen, för jag har inte Node på jobbdatorn.

## Diagnos (testad 2026-11-11)

### GdeltMCP
- 429 Too Many Requests vid tätt efterföljande anrop. GDELT DOC-API:t tål ungefär ett anrop per 5 s, och servern saknar väntan och retry.
- Fraser utan citattecken tolkas som lösa ord och ger irrelevanta träffar. `"electronic warfare"` i citat med sort=HybridRel ger relevanta träffar.
- Beskrivningen lovar fältet tone, men search_articles returnerar inget tone.

### research_grants
| Källa | Status | Orsak |
|---|---|---|
| CORDIS | fungerar, enorma svar | rå API-payload skickas vidare; 3 träffar ≈ 120 kB |
| NIH | fungerar, stora svar | fulla abstracts och terms |
| NSF | fungerar | – |
| Sverige | 404 | anropar `data.vinnova.se/api/projects?q=…`, som inte finns |
| UKRI GtR | 403 | trolig orsak: saknad Accept-header `application/vnd.rcuk.gtr.json-v7` och/eller blockerad User-Agent/IP; s måste vara 10–100 |

search_grants_multi med 3 träffar per källa gav 327 000 tecken och sprängde kontextgränsen.

## GDP-API:t (svenska myndigheter), från gdphub.se
- En bas-URL per myndighet: `https://api.vinnova.se/gdp_vinnova/`, `https://api.vr.se/gdp_vr/`, `https://api.formas.se/gdp_formas/`. Forte (`https://api.forte.se/gdp_forte/`) har ingen nyckel än.
- En nyckel per myndighet; jag har nycklar för Vinnova, VR och Formas. Nyckeln skickas som `authorization`: exemplen visar query-param `?authorization=<nyckel>`. Testa även header `Authorization`. Exemplet i dokumentationen har ett felaktigt andra `?` där `&` ska stå.
- Endpoints: `/metadata`, `/utlysningar`, `/ansokningar`, `/finansieradeaktiviteter`.
- Filter: diarienummer, organisationsnummer, franBeslutDatum/tillBeslutDatum, status (t.ex. Beviljad). Paging med limit och offset. Det finns ingen fritextsökning. Data uppdateras en gång per dygn.
- Fältnamn och svarsformat finns på https://github.com/Gemensamma-data-projektet-GDP/Dokumentation. Läs dem innan du skriver parsern.

## Plan, i prioritetsordning
1. Trimma alla grant-svar till titel, id, finansiär, belopp, koordinator, datum, URL och en sammanfattning på högst 500 tecken.
2. Sverige: en Cron Trigger hämtar finansieradeaktiviteter och utlysningar från de tre myndigheterna en gång per dygn och lagrar dem i D1 med SQLite FTS5. Sökningen körs lokalt mot D1. Nycklarna ligger som Worker secrets `GDP_KEY_VINNOVA`, `GDP_KEY_VR` och `GDP_KEY_FORMAS`, aldrig i kod.
3. Nytt verktyg: sök öppna utlysningar hos svenska myndigheter.
4. UKRI: versionerad Accept-header, riktig User-Agent, s ≥ 10. Om 403 kvarstår ska servern rapportera det tydligt.
5. GDELT: throttle på minst 5 s mellan anrop, retry med backoff vid 429 (respektera Retry-After), citattecken runt flerordsfraser automatiskt, och returnera tone eller ändra beskrivningen.
6. Tydliga felmeddelanden som skiljer på fel endpoint, blockering och rate limit.
