#= Sample PDV script for cross-language equivalence tests. =#

function run(pdv_tree::AbstractDict; x::Int=10, label::String="default")
    pdv_tree["result"] = x * 2
    pdv_tree["label"] = label
    return pdv_tree
end
