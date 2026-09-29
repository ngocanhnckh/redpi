// Office-files skill: its helper writes Word/PowerPoint/Excel files from Markdown and CSV, reads
// them back as Markdown, merges and splits PDFs. Runs through uv; skipped when uv is missing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skills/office-files/SKILL.md"), "utf8");
if (!/^---\nname: office-files\ndescription: .{50,1024}\n---/.test(skill)) { console.error("FAIL: SKILL.md frontmatter"); process.exit(1); }
if (spawnSync("uv", ["--version"]).status !== 0) { console.log("Office files test skipped: uv is not installed."); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), "redpi-office-test-"));
const fail = (msg, extra) => { console.error("FAIL:", msg, extra ?? ""); rmSync(dir, { recursive: true, force: true }); process.exit(1); };
const office = (...args) => {
  const r = spawnSync("uv", ["run", "--quiet", "--with", "python-docx", "--with", "openpyxl", "--with", "python-pptx", "--with", "pypdf", "python", join(root, "skills/office-files/office.py"), ...args], { cwd: dir, encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) {
    if (/network|resolve|connect|timed out/i.test(r.stderr)) { console.log("Office files test skipped: uv could not download the libraries (offline?)."); rmSync(dir, { recursive: true, force: true }); process.exit(0); }
    fail(`office.py ${args.join(" ")}`, r.stderr);
  }
  return r.stdout;
};

writeFileSync(join(dir, "in.md"), `# Quarterly report

Revenue grew **12%** this quarter.

## Highlights
- New customers: 42
  - Enterprise: 7
- Churn fell

| Region | Revenue |
|---|---|
| EU | 1.2M |
| US | 2.3M |

Notes: mention the EU launch
`);
writeFileSync(join(dir, "t.csv"), "name,qty,price\nwidget,3,2.50\ngadget,10,0.99\n");

office("docx", "in.md", "out.docx");
const doc = office("read", "out.docx");
for (const want of ["# Quarterly report", "## Highlights", "- New customers: 42", "  - Enterprise: 7", "**12%**", "| EU | 1.2M |"]) if (!doc.includes(want)) fail(`Word round trip should keep ${JSON.stringify(want)}`, doc);

office("pptx", "in.md", "out.pptx");
const deck = office("read", "out.pptx");
for (const want of ["## Slide 1: Quarterly report", "## Slide 2: Highlights", "  - Enterprise: 7", "| US | 2.3M |", "> Notes: mention the EU launch"]) if (!deck.includes(want)) fail(`PowerPoint round trip should keep ${JSON.stringify(want)}`, deck);

office("xlsx", "t.csv", "out.xlsx", "--sheet", "Sales");
const sheet = office("read", "out.xlsx");
if (!sheet.includes("## Sheet: Sales (3 rows × 3 columns)") || !sheet.includes("| gadget | 10 | 0.99 |")) fail("CSV to Excel", sheet);

// PDFs: build two one-page PDFs with pypdf, merge them, pick page 2.
const mk = (name) => spawnSync("uv", ["run", "--quiet", "--with", "pypdf", "python", "-c", `from pypdf import PdfWriter; w=PdfWriter(); w.add_blank_page(200,200); w.write(${JSON.stringify(name)})`], { cwd: dir });
mk("a.pdf"); mk("b.pdf");
office("merge", "ab.pdf", "a.pdf", "b.pdf");
office("pages", "ab.pdf", "2", "two.pdf");
const count = (f) => spawnSync("uv", ["run", "--quiet", "--with", "pypdf", "python", "-c", `from pypdf import PdfReader; print(len(PdfReader(${JSON.stringify(f)}).pages))`], { cwd: dir, encoding: "utf8" }).stdout.trim();
if (count("ab.pdf") !== "2" || count("two.pdf") !== "1") fail("PDF merge and page pick", { ab: count("ab.pdf"), two: count("two.pdf") });
const bad = spawnSync("uv", ["run", "--quiet", "--with", "pypdf", "python", join(root, "skills/office-files/office.py"), "pages", "ab.pdf", "5", "x.pdf"], { cwd: dir, encoding: "utf8" });
if (bad.status === 0 || !/outside 1-2/.test(bad.stderr) || existsSync(join(dir, "x.pdf"))) fail("out-of-range pages should be refused", bad.stderr);

rmSync(dir, { recursive: true, force: true });
console.log("Office files test passed: Markdown to Word and PowerPoint and back, CSV to Excel, PDF merge and page pick, bad page ranges refused.");
