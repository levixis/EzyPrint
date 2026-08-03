#!/usr/bin/env bash
G="/Users/harshvardhanjha/Desktop/good code latest/.claude/guard-destructive-db.sh"

check() {
  out=$(jq -n --arg c "$2" '{tool_name:"Bash",tool_input:{command:$c}}' | bash "$G")
  # No output at all is the guard's way of saying "nothing to object to".
  if [ -z "$out" ]; then
    d="allow"
  else
    d=$(echo "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"')
  fi
  if [ "$d" = "$1" ]; then r="ok  "; else r="FAIL"; fi
  printf "%s expected=%-5s got=%-5s  %s\n" "$r" "$1" "$d" "$(echo "$2" | tr '\n' ' ' | cut -c1-58)"
}

echo "── must BLOCK ──"
check deny 'cd "/Users/x/server" && npx prisma migrate diff --to-migrations --shadow-database-url "postgres://prod"'
check deny 'npx prisma migrate reset --force'
check deny 'cd server && npx prisma db push'
check deny 'DATABASE_URL=x npx prisma migrate dev --name foo'
check deny 'psql "$URL" -c "DROP TABLE orders;"'
check deny 'psql -c "truncate table users cascade"'
check deny 'npx tsx -e "await prisma.order.deleteMany()"'

echo
echo "── must ALLOW (writing *about* the danger) ──"
check allow 'git commit -m "fix: block --shadow-database-url and prisma migrate reset"'
check allow 'grep -rn "shadow-database-url" .claude/'
check allow 'echo "never run prisma db push"'
check allow 'cd "/Users/x" && git commit -F /tmp/msg.txt'

echo
echo "── must ALLOW (real safe commands) ──"
check allow 'npx prisma migrate deploy'
check allow 'cd server && npx prisma generate'
check allow 'npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script'
check allow 'npx prisma migrate status'
check allow 'npm test'
check allow 'npx tsx -e "await prisma.order.deleteMany({ where: { id } })"'
