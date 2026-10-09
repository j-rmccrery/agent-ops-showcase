# example-review-offbyone — reviewer must catch the 1-indexed page off-by-one

- [ ] G1: a BLOCKER/MAJOR line names paginate.js and the off-by-one start index
  CHECK: node -e "const s=require('fs').readFileSync('review-output.md','utf8');process.exit(s.split(/\r?\n/).some(l=>/^(BLOCKER|MAJOR)\b/.test(l)&&/paginate\.js/.test(l)&&/(off-by-one|1-indexed|page - 1|skips? the first page)/i.test(l))?0:1)"
  EVIDENCE: pending
- [ ] G2: review-output.md exists and is non-trivial
  CHECK: node -e "const s=require('fs').readFileSync('review-output.md','utf8');process.exit(s.length>200?0:1)"
  EVIDENCE: pending
