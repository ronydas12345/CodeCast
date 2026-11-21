export const LANGUAGES = [
  ["javascript", "JavaScript", "js"],
  ["typescript", "TypeScript", "ts"],
  ["python", "Python", "py"],
  ["html", "HTML", "html"],
  ["css", "CSS", "css"],
  ["json", "JSON", "json"],
  ["markdown", "Markdown", "md"],
  ["cpp", "C++", "cpp"],
  ["java", "Java", "java"],
  ["go", "Go", "go"],
  ["rust", "Rust", "rs"],
  ["php", "PHP", "php"],
  ["sql", "SQL", "sql"],
  ["xml", "XML", "xml"],
  ["plaintext", "Plain text", "txt"],
]

export function extensionFor(language) {
  return LANGUAGES.find((item) => item[0] === language)?.[2] || "txt"
}
