# Docx Skill

Create, edit, and modify `.docx` files with complete formatting, tables, images, and styles.

## Core Capabilities

- **Create documents**: Generate Word documents from scratch with headings, paragraphs, lists, and sections.
- **Edit documents**: Open existing `.docx` files, locate content, and apply precise modifications.
- **Tables**: Insert, populate, and style tables with merged cells, column widths, and alignment.
- **Images**: Embed local image files or base64 images with captions and positioning.
- **Styles**: Apply named styles (Heading 1-6, Normal, Quote, Code), font properties, paragraph spacing.
- **Headers/Footers**: Add page numbers, document title, and dynamic fields.
- **Track Changes**: Insert revisions with author and timestamp metadata.

## Library: python-docx

```python
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
```

## Creating a Document

```python
def create_report(title: str, sections: list[dict]) -> bytes:
    doc = Document()

    # Title
    heading = doc.add_heading(title, level=0)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for section in sections:
        doc.add_heading(section["heading"], level=1)
        doc.add_paragraph(section["body"])

        if section.get("table"):
            rows = section["table"]
            t = doc.add_table(rows=len(rows), cols=len(rows[0]))
            t.style = "Table Grid"
            for r_idx, row in enumerate(rows):
                for c_idx, cell_text in enumerate(row):
                    t.rows[r_idx].cells[c_idx].text = str(cell_text)

    # Save to bytes
    import io
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
```

## Editing an Existing Document

```python
def update_document(docx_bytes: bytes, replacements: dict[str, str]) -> bytes:
    import io
    doc = Document(io.BytesIO(docx_bytes))
    for para in doc.paragraphs:
        for old, new in replacements.items():
            if old in para.text:
                for run in para.runs:
                    run.text = run.text.replace(old, new)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
```

## Adding Images

```python
doc.add_picture("screenshot.png", width=Inches(6))
last_para = doc.paragraphs[-1]
last_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
```

## Applying Styles

```python
# Paragraph style
para = doc.add_paragraph("Important note", style="Intense Quote")

# Inline font
run = para.add_run(" — see appendix")
run.bold = True
run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x2E)
run.font.size = Pt(11)
```

## Page Numbers in Footer

```python
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

def add_page_numbers(doc: Document) -> None:
    section = doc.sections[0]
    footer = section.footer
    para = footer.paragraphs[0]
    para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = para.add_run()
    fld = OxmlElement("w:fldChar")
    fld.set(qn("w:fldCharType"), "begin")
    run._r.append(fld)
    instr = OxmlElement("w:instrText")
    instr.text = " PAGE "
    run._r.append(instr)
    fld2 = OxmlElement("w:fldChar")
    fld2.set(qn("w:fldCharType"), "end")
    run._r.append(fld2)
```

## Best Practices

- Always use `Inches()` or `Pt()` for measurements — never raw numbers.
- Use named styles for consistency; only override inline when truly necessary.
- Preserve original document styles when editing; don't recreate from scratch.
- For large documents, build paragraphs programmatically to avoid XML corruption.
- Return `bytes` (not file paths) to keep the tool composable with S3/databases.
