import { PrismaClient } from '@prisma/client'
import { getCurrentUser } from './src/services/auth.service'

const prisma = new PrismaClient()

async function main() {
  const user = await prisma.user.findFirst({ where: { email: 'harshop174@gmail.com' }, include: { shop: true } })
  if (!user) return console.log("User not found")
  
  const me = await getCurrentUser(user.id)
  console.log("getCurrentUser output:", JSON.stringify(me, null, 2))
}
main()
