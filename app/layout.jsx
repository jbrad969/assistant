export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <title>Jess AI</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #f7f7f8; }
          input, button { font-family: inherit; font-size: 14px; }
          input:focus { outline: 2px solid #111; border-radius: 4px; }
        `}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
