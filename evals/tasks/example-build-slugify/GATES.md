# example-build-slugify — implementer must satisfy the ticket's acceptance criteria (case-owned behavioral test)

- [ ] G1: hidden tests pass
  CHECK: npx jest tests/slugify.test.js --ci
  EVIDENCE: pending
- [ ] G2: full suite still passes
  CHECK: npm test -- --ci
  EVIDENCE: pending
- [ ] G3: diff stays inside utils and tests
  CHECK: (git diff --name-only main -- . ":!GATES.md" & git ls-files --others --exclude-standard) | grep -vE "^(src/utils/|tests/|GATES.md$)" | wc -l
  EXPECT: /^\s*0\s*$/
  EVIDENCE: pending
