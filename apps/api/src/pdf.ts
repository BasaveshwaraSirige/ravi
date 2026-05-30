type PdfLine = {
  text: string;
  bold?: boolean;
  size?: number;
  align?: "left" | "center" | "right";
};

function asciiSafe(s: string) {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) out += ch;
    else out += "?";
  }
  return out;
}

function escPdfText(s: string) {
  const safe = asciiSafe(s);
  return safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pad(n: number, width = 10) {
  return String(n).padStart(width, "0");
}

export function pdfFromLines(title: string, lines: PdfLine[]) {
  const pageWidth = 612; // 8.5in * 72
  const pageHeight = 792; // 11in * 72
  const marginX = 40;
  const startY = pageHeight - 60;
  const lineGap = 14;

  const pages: PdfLine[][] = [];
  let current: PdfLine[] = [];
  let y = startY;

  const pushLine = (l: PdfLine) => {
    if (y < 60) {
      pages.push(current);
      current = [];
      y = startY;
    }
    current.push(l);
    y -= lineGap;
  };

  pushLine({ text: title, bold: true, size: 16, align: "center" });
  pushLine({ text: "", size: 12 });
  for (const l of lines) pushLine(l);
  pages.push(current);

  const objects: string[] = [];
  const offsets: number[] = [];

  const addObj = (body: string) => {
    const id = objects.length + 1;
    objects.push(`${id} 0 obj\n${body}\nendobj\n`);
    return id;
  };

  const fontCourier = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const fontCourierBold = addObj(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>"
  );

  const pageIds: number[] = [];
  const textWidth = (text: string, size: number) => asciiSafe(text).length * size * 0.6;

  for (const p of pages) {
    const contentParts: string[] = [];
    contentParts.push("BT");
    for (let idx = 0; idx < p.length; idx += 1) {
      const line = p[idx];
      const size = line.size ?? 12;
      const fontId = line.bold ? fontCourierBold : fontCourier;
      const text = escPdfText(line.text);
      const y = startY - idx * lineGap;
      const align = line.align ?? "left";
      const rawText = String(line.text ?? "");
      let x = marginX;
      if (align === "center") {
        x = Math.max(marginX, (pageWidth - textWidth(rawText, size)) / 2);
      } else if (align === "right") {
        x = Math.max(marginX, pageWidth - marginX - textWidth(rawText, size));
      }
      contentParts.push(`/F${fontId} ${size} Tf`);
      contentParts.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
      contentParts.push(`(${text}) Tj`);
    }
    contentParts.push("ET");
    const stream = contentParts.join("\n");
    const contentId = addObj(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
    );

    const pageId = addObj(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F${fontCourier} ${fontCourier} 0 R /F${fontCourierBold} ${fontCourierBold} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  const pagesId = addObj(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${
      pageIds.length
    } >>`
  );

  // Fix up Parent refs in pages (replace "0 0 R" with pagesId)
  for (let i = 0; i < objects.length; i++) {
    objects[i] = objects[i].replace("/Parent 0 0 R", `/Parent ${pagesId} 0 R`);
  }

  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  offsets.push(0);
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${pad(offsets[i])} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}
