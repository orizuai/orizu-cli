export function renderCliAuthBrowserPage(status: 'success' | 'error'): string {
  const isSuccess = status === 'success'
  const eyebrow = isSuccess ? '// cli login complete' : '// cli login'
  const title = isSuccess ? 'Browser authorization complete' : 'Missing authorization code'
  const detail = isSuccess
    ? 'Your terminal will finish connecting the Orizu CLI. You can close this tab.'
    : 'Close this tab and run orizu login again to start a fresh browser request.'
  const accent = isSuccess ? '#E8923C' : '#C8442A'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orizu CLI Login</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;700&display=swap');
      :root {
        color-scheme: light;
        --paper: #F4EFE3;
        --border: #E6DFCE;
        --ink: #353535;
        --muted: #6B6358;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: #FFFFFF;
        color: #4B4B4B;
        font-family: 'Geist Mono', Menlo, Monaco, Consolas, monospace;
        letter-spacing: -0.025em;
      }
      main {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 48px 24px;
      }
      section {
        width: min(100%, 520px);
        text-align: center;
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        margin-bottom: 28px;
      }
      .brand svg {
        width: 42px;
        height: 42px;
        color: #202124;
      }
      .brand span {
        color: #000000;
        font-size: 16px;
        font-weight: 700;
      }
      .eyebrow {
        margin: 0 0 12px;
        color: ${accent};
        font-size: 12px;
        text-transform: lowercase;
      }
      h1 {
        margin: 0 0 8px;
        color: var(--ink);
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: -0.05em;
      }
      .detail {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <div class="brand" aria-hidden="true">
          <svg viewBox="0 0 2048 2048" xmlns="http://www.w3.org/2000/svg">
            <g fill="currentColor">
              <polygon points="1545,879 787,1195 1189,1577"></polygon>
              <polygon points="992,624 444,1104 688,1338"></polygon>
              <polygon points="602,1593 1180,1594 768,1202"></polygon>
              <polygon points="1650,1195 1398,1203 1204,1594 1229,1593"></polygon>
              <polygon points="807,413 751,509 823,744 980,608"></polygon>
              <polygon points="441,1127 592,1572 681,1356"></polygon>
              <polygon points="793,399 611,457 604,471 658,602"></polygon>
              <polygon points="593,493 498,667 636,600"></polygon>
            </g>
          </svg>
          <span>orizu</span>
        </div>
        <p class="eyebrow">${eyebrow}</p>
        <h1>${title}</h1>
        <p class="detail">${detail}</p>
      </section>
    </main>
  </body>
</html>`
}
