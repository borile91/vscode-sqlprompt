# Commit Guidelines

This project uses English-only commit messages.

## Rules

- Write commit subject and body in English.
- Keep the subject concise and imperative.
- Prefer Conventional Commits.

## Suggested format

```text
<type>(<scope>): <summary>
```

Common types:

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation changes
- `refactor`: internal improvements without behavior change
- `test`: tests added or updated
- `chore`: maintenance tasks

## Examples

- `docs(readme): move developer content to dedicated docs`
- `feat(server): add join-aware table suggestions`
- `fix(schema): handle empty default schema safely`

## Notes

- One commit should represent one logical change.
- If needed, add details in the commit body in English.
