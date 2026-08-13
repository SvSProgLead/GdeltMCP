# gdelt-mcp

Egen MCP-server mot [GDELT Project](https://www.gdeltproject.org/)'s öppna DOC API,
hostad på er egen Cloudflare Workers-instans. Ingen tredjepartsgateway inblandad —
er Worker anropar `api.gdeltproject.org` direkt.

## Verktyg

- **search_articles** – sök nyhetsartiklar på ett ämne
- **timeline_tone** – daglig sentimentnivå (-100 till +100) för ett ämne
- **timeline_volume** – daglig andel av det globala nyhetsflödet för ett ämne

## Förutsättningar

- Node.js 18+ och npm
- Ett gratis Cloudflare-konto: https://dash.cloudflare.com/sign-up

## Installera och kör lokalt

```bash
npm install
npm run dev
```

Wrangler startar en lokal server, vanligtvis på `http://localhost:8787/mcp`.

Testa den med MCP Inspector innan ni driftsätter:

```bash
npx @modelcontextprotocol/inspector@latest
```

Öppna inspектorn i webbläsaren, ange `http://localhost:8787/mcp` som server-URL
och klicka **Connect** → **List Tools**.

## Driftsätt till Cloudflare

```bash
npx wrangler login      # första gången, öppnar webbläsaren för inloggning
npm run deploy
```

Efter deploy får ni en URL i stil med:

```
https://gdelt-mcp.<ert-konto>.workers.dev/mcp
```

Det är denna URL teamet ansluter till från Claude.

## Anslut från Claude (claude.ai / Claude Desktop / mobil)

1. Gå till **Inställningar → Connectors**.
2. Klicka **"+"** / lägg till anpassad connector.
3. Klistra in er Worker-URL: `https://gdelt-mcp.<ert-konto>.workers.dev/mcp`
4. Ingen autentisering krävs (servern är avsiktligt öppen/authless — se
   säkerhetsavsnittet nedan om ni vill begränsa åtkomst).

## Anslut från Claude Desktop via lokal proxy (alternativ, för test)

```json
{
  "mcpServers": {
    "gdelt": {
      "command": "npx",
      "args": ["mcp-remote", "https://gdelt-mcp.<ert-konto>.workers.dev/mcp"]
    }
  }
}
```

## Säkerhet / åtkomstbegränsning

Servern är byggd utan autentisering (authless), precis som Pipeworx-varianten,
eftersom GDELT:s data i sig är offentlig. Men eftersom det är *er* Worker kan ni
enkelt låsa ner den om ni vill att bara teamet ska kunna använda den:

- **Enklast:** lägg till Cloudflare Access framför Workern
  (https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/).
  Kräver inloggning via er identity provider (Google Workspace, Entra ID, etc.)
  innan någon når `/mcp`.
- **Alternativ:** lägg till en delad hemlig nyckel som måste skickas som header,
  och kontrollera den i `src/index.ts` innan requesten släpps vidare till handlern.

## Anpassa

Lägg till fler verktyg genom att kalla `server.registerTool(...)` igen inuti
`createServer()` i `src/index.ts`, t.ex. för fler GDELT-lägen som
`ToneChart`, `WordCloud` eller `ImageCollageInfo` — se GDELT:s API-dokumentation:
https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

## Kostnad

Cloudflare Workers gratisnivå ger 100 000 requests/dag, vilket räcker gott för
teamanvändning. GDELT:s API är gratis och kräver ingen nyckel.
