# Copilot Instructions

## Language policy

- Always write in English for all source code comments, documentation, issue templates, pull request text, and assistant-generated content in this repository.
- If a user request is in another language, keep communication concise but produce repository artifacts in English.

## Commit policy

- Commit messages must always be in English.
- Use Conventional Commits when possible.
- Preferred format: `<type>(<scope>): <short summary>`

## Copilot commit message generation

- When asked to generate a commit message, always return an English message.
- Default to Conventional Commits format: `<type>(<scope>): <summary>`.
- Use imperative, concise wording in the summary.
- Keep the subject line focused on one logical change.
- Do not include emojis, non-English text, or trailing punctuation in the subject.
- If useful, also provide an optional English body with brief bullet points describing key changes.

Examples:

- `docs(readme): improve first-time user setup section`
- `feat(server): add alias-aware table completion`
- `fix(client): reload schema when active editor changes`
