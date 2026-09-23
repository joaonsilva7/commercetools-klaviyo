import { AbstractEventProcessor } from '../abstractEventProcessor';
import logger from '../../../../utils/log';
import { OrderStateChangedMessage } from '@commercetools/platform-sdk/dist/declarations/src/generated/models/message';
import { Order,OrderState, Product } from '@commercetools/platform-sdk';
import config from 'config';
import { PaginatedProductResults } from '../../../../infrastructure/driven/commercetools/DefaultCtProductService';
import { EventRequest } from '../../../../types/klaviyo-types';
import { KlaviyoEvent } from '../../../../types/klaviyo-plugin';

export class OrderStateChangedEvent extends AbstractEventProcessor {
    private readonly PROCESSOR_NAME = ' OrderStateChanged';

    isEventValid(): boolean {
        const orderStateChangedMessage = this.ctMessage as unknown as OrderStateChangedMessage;
        return (
            orderStateChangedMessage.resource.typeId === 'order' &&
            this.isValidMessageType(orderStateChangedMessage.type) &&
            this.isValidState(orderStateChangedMessage.orderState) &&
            !this.isEventDisabled(this.PROCESSOR_NAME)
        );
    }

    async generateKlaviyoEvents(): Promise<KlaviyoEvent[]> {
        const orderStateChangedMessage = this.ctMessage as unknown as OrderStateChangedMessage;
        logger.info('Processing order state changed event');

        const ctOrder = await this.context.ctOrderService.getOrderById(orderStateChangedMessage.resource.id);

        if (!ctOrder) {
            return [];
        }

        let orderProducts: Product[] = [];
        let ctProductsResult: PaginatedProductResults | undefined;
        do {
            try {
                ctProductsResult = await this.context.ctProductService.getProductsByIdRange(
                    ctOrder.lineItems.map((item) => item.productId),
                    ctProductsResult?.lastId,
                );
                orderProducts = orderProducts.concat(ctProductsResult.data);
            } catch (err) {
                logger.info(`Failed to get product details for order: ${ctOrder.id}`, err);
            }
        } while ((ctProductsResult as PaginatedProductResults)?.hasMore);

        const metric = this.getOrderMetricByState(orderStateChangedMessage.orderState);

        const body: EventRequest = this.context.orderMapper.mapCtOrderToKlaviyoEvent(
            ctOrder,
            orderProducts,
            metric,
            false,
            ctOrder.lastModifiedAt,
        );

        const events: KlaviyoEvent[] = [{ body, type: 'event' }];

        if (metric === config.get('order.metrics.fulfilledOrder')) {
            this.getProductOrderedEventsFromOrder(events, ctOrder);
        }

        return events;
    }

    private getProductOrderedEventsFromOrder(events: KlaviyoEvent[], order: Order) {
        const eventTime: Date = new Date(order.lastModifiedAt);
        eventTime.setSeconds(eventTime.getSeconds() + 1);
        order?.lineItems?.forEach((lineItem) => {
            events.push({
                body: this.context.orderMapper.mapOrderLineToProductOrderedEvent(
                    lineItem,
                    order,
                    eventTime.toISOString(),
                ),
                type: 'event',
            });
        });
    }
    private isValidState(orderState: OrderState): boolean {
        return Boolean(
            config.has('order.states.changed') &&
                ((config.get('order.states.changed.cancelledOrder') as string[])?.includes(orderState) ||
                    (config.get('order.states.changed.fulfilledOrder') as string[])?.includes(orderState)),
        );
    }

    private isValidMessageType(type: string): boolean {
        return Boolean(
            config.has('order.messages.changed') && (config.get('order.messages.changed') as string[])?.includes(type),
        );
    }

    private getOrderMetricByState(orderState: OrderState): string {
        const changedStates: any = config.get('order.states.changed');
        const orderMetrics: any = config.get('order.metrics');
        const stateProperty = Object.entries(changedStates).filter((state) =>
            (state[1] as string[]).includes(orderState),
        )[0][0];
        return orderMetrics[stateProperty];
    }
}
