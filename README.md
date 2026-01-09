# The Eye 👁️

Monitor recurrente de documentos gubernamentales con notificación a Telegram.

## Características

- 🔍 **Navegación automatizada** con Playwright (clics, formularios, cookies)
- 📄 **Extracción de documentos** basada en selectores CSS configurables
- 🔄 **Detección de cambios** (nuevos documentos, actualizaciones)
- 📱 **Notificaciones a Telegram** con archivos adjuntos
- ⚙️ **Ejecución programada** via GitHub Actions
- 🧪 **Modo Dry Run** para probar configuraciones

## Inicio Rápido

### 1. Configurar Secrets en GitHub

En tu repositorio: **Settings → Secrets → Actions**, añade:

- `TELEGRAM_BOT_TOKEN` - Token de tu bot (de @BotFather)
- `TELEGRAM_CHAT_ID` - ID del chat/grupo donde enviar notificaciones

### 2. Crear Configuración

Copia `config/sites.example.json` a `config/sites.json` y edita:

```json
{
  "sites": [
    {
      "id": "mi-sitio",
      "name": "Mi Sitio Gubernamental",
      "enabled": true,
      "url": "https://ejemplo.gob.es/documentos",
      "steps": [
        {"action": "click", "selector": "#aceptarCookies", "optional": true},
        {"action": "waitForSelector", "selector": ".lista-documentos"}
      ],
      "extraction": {
        "listSelector": ".lista-documentos .documento",
        "fields": {
          "title": {"selector": "h3"},
          "url": {"selector": "a[href$='.pdf']", "attribute": "href"},
          "date": {"selector": ".fecha", "optional": true}
        }
      }
    }
  ]
}
```

### 3. Probar Localmente

```bash
npm install
npx playwright install chromium

# Dry run (sin guardar estado ni enviar a Telegram)
npm run dry-run

# Probar un solo sitio
node runner/index.js --dry-run --site-id=mi-sitio
```

### 4. Activar el Monitor

Haz push a GitHub. El workflow se ejecutará automáticamente cada 30 minutos.

Para ejecutar manualmente: **Actions → Document Monitor → Run workflow**

## Acciones Soportadas

| Acción | Parámetros | Descripción |
|--------|------------|-------------|
| `click` | `selector`, `optional`, `timeout` | Clic en elemento |
| `waitForSelector` | `selector`, `state`, `timeout` | Esperar elemento visible |
| `fill` | `selector`, `value` | Rellenar campo de texto |
| `press` | `selector?`, `key` | Pulsar tecla |
| `scroll` | `selector?`, `distance` | Hacer scroll |
| `wait` | `duration` | Esperar N milisegundos |
| `wait_ajax` | `timeout` | Esperar a que no haya peticiones pendientes |
| `select` | `selector`, `value` | Seleccionar opción en dropdown |

## Validación de Descargas

El sistema valida automáticamente los archivos descargados usando "magic numbers":

- ✅ Rechaza páginas HTML de error disfrazadas de PDF
- ✅ Verifica Content-Type en descargas directas
- ✅ Calcula hash SHA256 para detectar actualizaciones silenciosas

## Workflows

| Workflow | Trigger | Descripción |
|----------|---------|-------------|
| `monitor.yml` | Cron + Manual | Ejecuta el monitor principal |
| `manual-test.yml` | Manual | Prueba configuración sin guardar estado |
| `process-config-issue.yml` | Issue con label | Procesa Issues con JSON de configuración |

## Estructura

```
The Eye/
├── config/
│   ├── sites.json          # Configuración de sitios
│   └── sites.example.json  # Ejemplo de configuración
├── runner/
│   ├── index.js            # Orquestador principal
│   ├── Navigator.js        # Motor de navegación
│   ├── Extractor.js        # Extractor de documentos
│   ├── Downloader.js       # Descarga + validación
│   ├── StateManager.js     # Gestión de estado
│   └── TelegramNotifier.js # Notificaciones
├── state/                  # Estado (branch separado)
├── .github/workflows/      # GitHub Actions
└── package.json
```

## Licencia

MIT
