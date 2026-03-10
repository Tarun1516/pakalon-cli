# PDF Skill

Read, extract, merge, split, create, watermark, fill forms, and OCR scan PDF files.

## Core Capabilities

- **Extract text**: Read full text or specific pages from PDFs with structure preservation.
- **Create PDFs**: Generate new PDFs from HTML, Markdown, or structured data.
- **Merge / Split**: Combine multiple PDFs or extract page ranges.
- **Watermark**: Overlay text or image watermarks on existing PDFs.
- **Form filling**: Detect AcroForm fields and fill them programmatically.
- **OCR**: Extract text from scanned/image-based PDFs via Tesseract or LLM vision.
- **Metadata**: Read and write author, title, subject, keywords.

## Libraries

```python
# Primary: pypdf (pure-Python, no native deps)
from pypdf import PdfReader, PdfWriter, PageObject

# HTML → PDF
from weasyprint import HTML  # or: import pdfkit

# OCR fallback
import pytesseract
from PIL import Image
```

## Extract Text

```python
def extract_text(pdf_bytes: bytes, pages: list[int] | None = None) -> str:
    import io
    reader = PdfReader(io.BytesIO(pdf_bytes))
    target = [reader.pages[i] for i in pages] if pages else reader.pages
    return "\n\n".join(p.extract_text() or "" for p in target)
```

## Create PDF from HTML

```python
def html_to_pdf(html: str) -> bytes:
    from weasyprint import HTML
    import io
    buf = io.BytesIO()
    HTML(string=html).write_pdf(buf)
    return buf.getvalue()
```

## Merge PDFs

```python
def merge_pdfs(pdf_bytes_list: list[bytes]) -> bytes:
    import io
    writer = PdfWriter()
    for pdf_bytes in pdf_bytes_list:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        for page in reader.pages:
            writer.add_page(page)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
```

## Split PDF — Extract Page Range

```python
def extract_pages(pdf_bytes: bytes, start: int, end: int) -> bytes:
    """Extract pages [start, end) (0-indexed)."""
    import io
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for i in range(start, min(end, len(reader.pages))):
        writer.add_page(reader.pages[i])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
```

## Add Text Watermark

```python
def add_watermark(pdf_bytes: bytes, text: str) -> bytes:
    import io
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import A4

    # Build watermark page
    wm_buf = io.BytesIO()
    c = rl_canvas.Canvas(wm_buf, pagesize=A4)
    c.setFont("Helvetica", 60)
    c.setFillColorRGB(0.8, 0.8, 0.8, alpha=0.3)
    c.saveState()
    c.translate(A4[0] / 2, A4[1] / 2)
    c.rotate(45)
    c.drawCentredString(0, 0, text)
    c.restoreState()
    c.save()

    wm_reader = PdfReader(io.BytesIO(wm_buf.getvalue()))
    wm_page = wm_reader.pages[0]

    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    for page in reader.pages:
        page.merge_page(wm_page)
        writer.add_page(page)

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
```

## Fill AcroForm

```python
def fill_form(pdf_bytes: bytes, field_values: dict[str, str]) -> bytes:
    import io
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)
    writer.update_page_form_field_values(writer.pages[0], field_values)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()
```

## OCR Scanned PDF

```python
def ocr_pdf(pdf_bytes: bytes) -> str:
    """Convert scanned PDF pages to text via Tesseract."""
    import io, fitz  # PyMuPDF
    import pytesseract
    from PIL import Image

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    texts = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        texts.append(pytesseract.image_to_string(img))
    return "\n\n".join(texts)
```

## Best Practices

- Use `pypdf` for read-only extraction (zero native dependencies).
- Use `WeasyPrint` for HTML→PDF — it fully supports CSS3 and properly handles `@page`.
- Never modify PDFs in-place; always read → transform → write to a new bytes buffer.
- For scanned PDFs with no embedded text, always OCR rather than returning empty strings.
- Add watermarks with low opacity (0.2–0.3) so underlying content remains readable.
