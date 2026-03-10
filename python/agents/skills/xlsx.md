# XLSX Skill

Create and modify Excel files with formulas, charts, pivot tables, conditional formatting, and data validation.

## Core Capabilities

- **Create workbooks**: Generate `.xlsx` files with named sheets, headers, typed data.
- **Formulas**: Write Excel formula strings (`SUM`, `VLOOKUP`, `IF`, `COUNTIF`, array formulas).
- **Charts**: Embed bar, line, pie, area, and scatter charts from worksheet data ranges.
- **Pivot tables**: Summarise large datasets with grouped rows/columns and aggregations.
- **Conditional formatting**: Highlight cells by value, data bars, colour scales, icon sets.
- **Data validation**: Dropdown lists, number ranges, custom formula constraints.
- **Styles**: Cell fonts, borders, fills, number formats, alignment.
- **Large datasets**: Stream-write million-row exports with `openpyxl.writer.excel.ExcelWriter`.

## Library: openpyxl

```python
import openpyxl
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, numbers
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.formatting.rule import ColorScaleRule, DataBarRule, CellIsRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter
```

## Creating a Workbook

```python
def create_report(data: list[dict], sheet_name: str = "Report") -> bytes:
    import io
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name

    if not data:
        buf = io.BytesIO(); wb.save(buf); return buf.getvalue()

    headers = list(data[0].keys())
    ws.append(headers)

    # Style header row
    header_fill = PatternFill("solid", fgColor="1A1A2E")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")

    for row in data:
        ws.append([row.get(h) for h in headers])

    # Auto-fit column widths
    for col in ws.columns:
        max_len = max(len(str(cell.value or "")) for cell in col)
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 4, 50)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

## Writing Formulas

```python
# Sum column B rows 2–100
ws["B101"] = "=SUM(B2:B100)"

# VLOOKUP: find value from C2 in column A, return column B
ws["D2"] = '=VLOOKUP(C2,$A:$B,2,FALSE)'

# Conditional IF
ws["E2"] = '=IF(D2>1000,"High","Low")'

# Array formula (Ctrl+Shift+Enter equivalent)
ws["F2"] = "=SUMPRODUCT((A2:A100>0)*(B2:B100))"
```

## Bar Chart

```python
def add_bar_chart(ws, data_range_start: int, data_range_end: int, chart_title: str) -> None:
    chart = BarChart()
    chart.title = chart_title
    chart.style = 10
    data = Reference(ws, min_col=2, min_row=data_range_start, max_row=data_range_end)
    cats = Reference(ws, min_col=1, min_row=data_range_start + 1, max_row=data_range_end)
    chart.add_data(data, titles_from_data=True)
    chart.set_categories(cats)
    chart.shape = 4
    ws.add_chart(chart, "E5")
```

## Conditional Formatting — Color Scale

```python
from openpyxl.formatting.rule import ColorScaleRule

ws.conditional_formatting.add(
    "B2:B100",
    ColorScaleRule(
        start_type="min", start_color="F8696B",
        mid_type="percentile", mid_value=50, mid_color="FFEB84",
        end_type="max", end_color="63BE7B",
    ),
)
```

## Data Validation — Dropdown

```python
dv = DataValidation(type="list", formula1='"Low,Medium,High"', allow_blank=True)
ws.add_data_validation(dv)
dv.add(ws["C2:C100"])
```

## Number Formats

```python
from openpyxl.styles.numbers import FORMAT_CURRENCY_USD_SIMPLE, FORMAT_PERCENTAGE_00

ws["B2"].number_format = FORMAT_CURRENCY_USD_SIMPLE   # $1,234.56
ws["C2"].number_format = FORMAT_PERCENTAGE_00          # 12.35%
ws["D2"].number_format = "YYYY-MM-DD"                  # 2025-01-15
```

## Reading / Editing Existing XLSX

```python
def update_cells(xlsx_bytes: bytes, updates: dict[str, str | float]) -> bytes:
    """updates: {"Sheet1!A2": "new value", "Sheet1!B5": 42.0}"""
    import io
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_bytes))
    for cell_ref, value in updates.items():
        if "!" in cell_ref:
            sheet_name, cell = cell_ref.split("!", 1)
            ws = wb[sheet_name]
        else:
            ws = wb.active
            cell = cell_ref
        ws[cell] = value
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
```

## Best Practices

- Use named tables (`ws.add_table`) for data ranges — enables auto-filter and structured references.
- Freeze the header row: `ws.freeze_panes = "A2"`.
- Never embed raw Python `float` for currency — always use `Decimal` → `float` conversion + number format.
- For > 100k rows, use `write_only=True` mode to avoid memory exhaustion.
- Keep formula strings in Python as raw strings — avoid f-strings that might corrupt `$` signs.
