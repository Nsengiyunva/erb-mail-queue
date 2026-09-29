const basicAuth = require('express-basic-auth')
const { createBullBoard } = require('@bull-board/api')
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter')
const { ExpressAdapter } = require('@bull-board/express')
const { invoiceEmailQueue } = require('./queues/invoiceQueue')

module.exports = function mountBullBoard(app) {
    const serverAdapter = new ExpressAdapter()
    serverAdapter.setBasePath('/admin/queues')

    createBullBoard({
        queues: [new BullMQAdapter(invoiceEmailQueue)],
        serverAdapter,
        options: { uiConfig: { boardTitle: 'ERB Email Queue' } },
    })

    app.use(
        '/admin/queues',
        basicAuth({
            users: { [process.env.BULL_BOARD_USER || 'admin']: process.env.BULL_BOARD_PASS || 'change-me' },
            challenge: true,
        }),
        serverAdapter.getRouter()
    )
}