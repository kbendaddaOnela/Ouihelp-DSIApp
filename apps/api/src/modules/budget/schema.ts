import { mysqlTable, varchar, decimal, date, int, text, timestamp, mysqlEnum } from 'drizzle-orm/mysql-core'

export const budgetItems = mysqlTable('budget_items', {
  id: varchar('id', { length: 36 }).notNull().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  vendor: varchar('vendor', { length: 255 }),
  category: mysqlEnum('category', ['cloud', 'saas', 'hardware', 'license', 'support', 'telecom', 'other']).notNull().default('other'),
  quantity: int('quantity').notNull().default(1),
  unitCost: decimal('unit_cost', { precision: 12, scale: 2 }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull().default('0'),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  billingCycle: mysqlEnum('billing_cycle', ['monthly', 'quarterly', 'annual', 'one_time']).notNull().default('annual'),
  contractStart: date('contract_start'),
  contractEnd: date('contract_end'),
  autoRenewal: int('auto_renewal').notNull().default(0),
  renewalAlertDays: int('renewal_alert_days').notNull().default(60),
  status: mysqlEnum('status', ['active', 'expiring_soon', 'expired', 'cancelled']).notNull().default('active'),
  billingEntity: mysqlEnum('billing_entity', ['BALM', 'NHS', 'NHS PACA', 'ONELA Services', 'ONELA SAS', 'Colisee Domicile']),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})
