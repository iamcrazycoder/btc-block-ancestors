const { default: axios } = require("axios");
const Bluebird = require("bluebird");
const retry = require('bluebird-retry');

const BlockstreamAPI = "https://blockstream.info/api";

// Get all transactions for the block hash. Internally fetches in chunks to avoid getting rate limited
async function fetchAllTxsByBlock(blockHash) {
    const { tx_count: totalTransactions } = await getBlockInfo(blockHash);
    const pageIndexes = getPageIndexes(totalTransactions);
    const result = await Bluebird.map(pageIndexes, async(index) => {
        const { data } = await axios.get(`${BlockstreamAPI}/block/${blockHash}/txs/${index}`)
        return data;
    }, {
        concurrency: 4
    });

    return [].concat.apply([], result);
}

// generate array of indexes to fetch txs in batches
function getPageIndexes(total) {
    const chunkSize = 25;
    const indexes = [];
    let counter = 0;

    while(counter < total) {
        indexes.push((total - counter) < chunkSize ? total - counter: chunkSize);
        counter += chunkSize;
    }

    return indexes;
}

// get basic info of a block by hash
async function getBlockInfo(blockHash) {
    const { data } = await axios.get(`${BlockstreamAPI}/block/${blockHash}`)
    return data;
}

// get basic info of a txn by id
async function getTxInfo(txIds) {
    if(typeof txIds === "string") {
        txIds = [txIds];
    }

    const result = await Bluebird.map(txIds, async(txId) => {
        const { data } = await axios.get(`${BlockstreamAPI}/tx/${txId}/status`);
        return {...data, txId};
    }, {
        concurrency: 2
    })

    return result;
}

// Graph class
class Graph {
    constructor(numberOfVertices) {
        this.numberOfVertices = numberOfVertices;
        this.list = new Map();
    }

    addVertex(v) {
        this.list.set(v, []);
    }

    addEdge(v, w) {
        this.list.get(v).push(w);
        this.list.get(w).push(v);
    }

    printGraph() {
        this.list.forEach(v => console.log(`Txn >> ${v}`, v.length))
    }
}

async function buildGraph(data, blockHash) {
    const dataSize = data.length;
    const graph = new Graph(dataSize);

    async function fetchData() {
        await Bluebird.map(data, async(tx) => {
            const immediateParents = tx.vin.map(d => d.txid);
            const parentTxInfo = (await getTxInfo(immediateParents) || []).filter(tx => tx.block_hash === blockHash)
            // console.log(immediateParents.length, parentTxInfo.length);

            parentTxInfo.forEach(parentTx => {
                graph.addVertex(parentTx.txId);
                graph.addEdge(parentTx.txId, tx.txid);
            })
        }, {
            concurrency: 20
        })
    }

    try {
        await retry(fetchData, {
            max_tries: 3,
            interval: 500,
            backoff: 1
        });
    } catch(error) {
        console.log("Max retry failed")
    }
     
    graph.printGraph()
}

;(async() => {
    const blockHash = '000000000000000000076c036ff5119e5a5a74df77abf64203473364509f7732';
    const txs = await fetchAllTxsByBlock(blockHash);
    await buildGraph(txs, blockHash);
})();