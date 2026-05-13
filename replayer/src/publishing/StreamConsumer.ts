import * as stream from 'stream';

/**
 *  The StreamConsumer class is a class that extends the stream.Writable class. It is used to add quads to a store.
 */
export class StreamConsumer extends stream.Writable {
    public store: any;
    /**
     * Constructor for the StreamConsumer class.
     * @param {any} store - The store to add the quads to.
     */
    constructor(store: any) {
        super({ objectMode: true });
        this.store = store;
    }

    /**
     * Adds a quad to the store.
     * @param {any} quad - The quad to add.
     * @param {any} encoding - The encoding.
     * @param {any} done - The callback function.
     */
    _write(quad: any, encoding: any, done: any) {
        this.store.add(quad);
        done();
    }
    /**
     * Returns the writer.
     * @returns {StreamConsumer} - The writer.
     */
    get_writer(){
        return this;
    }
}